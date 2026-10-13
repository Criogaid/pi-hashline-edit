import { rejectsArgument } from "./argument-error.testing.ts";
import { computeLineHash } from "../core/hash.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { byteRevision, commitFreshness, FileMutationError } from "./file-commit.ts";
import { finalizeMutation, postProcessMutation, type MutationOutcome } from "./mutation-result.ts";
import { CommandNotRun, decodeReport, reportOf } from "./report.ts";
import { REREAD } from "./report-schema.ts";
import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";

const text = (result: Pick<AgentToolResult<unknown>, "content">): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

const invoke = (
  tool: any,
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  context?: unknown,
) => callTool(tool, args, { toolCallId, signal, onUpdate, ctx: context });

function assertFailureByteBudgets(message: string): void {
  const report = decodeReport(message);
  assert.ok(report);
  assert.equal(report.error, "ANCHOR_MISMATCH");
  assert.ok(report.failures && report.failures.length > 0);
  assert.ok(
    Buffer.byteLength(JSON.stringify(report.failures)) <= DEFAULT_OUTPUT_BUDGETS.blockBytes,
  );
  assert.equal(report.failures.length + (report.omittedFailures ?? 0), 1000);
  assert.ok(report.omittedFailures);
  assert.equal(report.matched, undefined);
  assert.equal(report.omittedMatched, undefined);
  assert.ok(report.next?.includes("intended target"));
  if (report.candidateNeighborhoods) {
    const rows = report.candidateNeighborhoods.flatMap((group) => group.rows);
    assert.ok(rows.length > 0);
    assert.ok(Buffer.byteLength(rows.join("\n")) + 1 <= DEFAULT_OUTPUT_BUDGETS.blockBytes);
  }
}

test("replace withholds anchors in progress and after commands change or remove the file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-result-"));
  try {
    for (const state of ["changed", "missing", "unknown"] as const) {
      for (const fails of [false, true]) {
        const path = join(dir, `${state}-${fails}.txt`);
        await writeFile(path, "before\n");
        const updates: any[] = [];
        const fusion = createActionFusionExecutor(async (_id, _input, _signal, _ctx, onUpdate) => {
          if (state === "changed") await writeFile(path, "command output\n");
          else {
            await rm(path);
            if (state === "unknown") await mkdir(path);
          }
          onUpdate?.({ content: [{ type: "text", text: "progress" }], details: undefined });
          if (fails) throw new Error("command failed");
          return { status: "succeeded", output: "done" };
        });
        const result = await invoke(
          makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
          "replace",
          {
            path,
            replacements: [{ find: "before", replace: "after" }],
            then_run: { command: "check" },
          },
          undefined,
          (update: any) => updates.push(update),
          await ctx(dir, t),
        );
        assert.ok(result.details.actionFusion);
        assert.equal(result.details.actionFusion.freshness, state);
        assert.equal(result.details.publication, "PUBLISHED");
        assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
        assert.equal(reportOf(result)?.freshness, state);
        assert.equal(reportOf(result)?.next, REREAD);
        assert.equal(result.content.length, 1);
        for (const update of updates)
          assert.doesNotMatch(text(update), /Updated anchors|\d+#[0-9A-Z]+│/);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress callback failures preserve publication and do not prevent the command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-progress-"));
  try {
    for (const callback of ["reporter", "update"]) {
      let commands = 0;
      const fail = () => {
        throw new Error("display unavailable");
      };
      const fusion = createActionFusionExecutor(
        async () => {
          commands++;
          return { status: "succeeded", output: "done" };
        },
        callback === "reporter" ? fail : undefined,
      );
      const path = join(dir, callback);
      const result = await invoke(
        makeWriteOverride(dir, fusion),
        "write",
        {
          path,
          content: "saved\n",
          mode: "create",
          then_run: { command: "check" },
        },
        undefined,
        callback === "update" ? fail : undefined,
        await ctx(dir, t),
      );
      assert.equal(commands, 1);
      assert.equal(await readFile(path, "utf8"), "saved\n");
      assert.ok(result.details.actionFusion);
      assert.equal(result.details.actionFusion.publication, "PUBLISHED");
      assert.equal(result.details.actionFusion.command, "succeeded");
      assert.match(text(result), /display unavailable/);
    }
    const fusion = createActionFusionExecutor(undefined, () => {
      throw new Error("display unavailable");
    });
    await assert.rejects(
      fusion({
        toolCallId: "failed",
        absolutePath: join(dir, "failed"),
        tool: "write",
        displayPath: "failed",
        thenRun: { command: "check" },
        mutate: async () => {
          throw new FileMutationError(
            "POST_PROCESS_FAILED",
            "post_process",
            "PUBLISHED",
            "original failure",
          );
        },
        signal: undefined,
        ctx: await ctx(dir, t),
      }),
      (error: unknown) =>
        error instanceof CommandNotRun &&
        error.error instanceof FileMutationError &&
        error.error.publication === "PUBLISHED" &&
        /original failure/.test(error.error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone and Fusion finalizers → take freshness from commit facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-finalizer-"));
  try {
    for (const publication of ["PUBLISHED", "NOT_PUBLISHED"] as const) {
      for (const observedRevision of ["published", "external"]) {
        const mutation = {
          details: {
            publication: "UNKNOWN",
            publishedRevision: "ignored",
            observedRevision: "ignored",
          },
          facts: {},
          commit: {
            publication,
            baseRevision: "published",
            publishedRevision: "published",
            observedRevision,
            created: false,
          },
        } satisfies MutationOutcome<object>;
        const fresh = observedRevision === "published";
        const observation = commitFreshness(mutation.commit);
        assert.equal(observation.freshness, fresh ? "unchanged" : "changed");
        const standalone = finalizeMutation("edit", "file", mutation, observation);
        const fused = await createActionFusionExecutor()({
          tool: "edit",
          displayPath: "file",
          toolCallId: "no-command",
          absolutePath: join(dir, "file"),
          thenRun: undefined,
          mutate: async () => mutation,
          signal: undefined,
          ctx: await ctx(dir, t),
        });
        assert.deepEqual(fused.content, standalone.content);
        assert.equal(standalone.details.publication, "UNKNOWN");
        assert.equal(reportOf(standalone)?.publication, publication);
        assert.equal(reportOf(fused)?.publication, publication);
        assert.equal(reportOf(standalone)?.freshness, fresh ? undefined : "changed");
        assert.deepEqual(mutation.details, {
          publication: "UNKNOWN",
          publishedRevision: "ignored",
          observedRevision: "ignored",
        });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregate anchor diagnostics → respect their byte budgets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-budget-"));
  try {
    const path = join(dir, "long.txt");
    await writeFile(path, "current\n");
    const failure = await invoke(
      makeEditOverride(dir, DEFAULT_CONFIG),
      "errors",
      { path, edits: Array.from({ length: 1000 }, () => ({ op: "delete", anchor: "1#XXXX" })) },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.equal(failure.isError, true);
    assertFailureByteBudgets(text(failure));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unpaired surrogate arguments are rejected before Fusion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-unicode-"));
  try {
    let commands = 0;
    const events: string[] = [];
    const fusion = createActionFusionExecutor(
      async () => {
        commands++;
        return { status: "succeeded", output: "done" };
      },
      (event) => events.push(event.command),
    );
    const path = join(dir, "file.txt");
    await writeFile(path, "original\n");
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: { path, edits: [{ op: "append", body: ["\ud800"] }], then_run: { command: "check" } },
        field: "edits[0].body[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ find: "original", replace: "\udfff" }],
          then_run: { command: "check" },
        },
        field: "replacements[0].replace",
      },
      {
        tool: makeWriteOverride(dir, fusion),
        args: { path, content: "\ud800", mode: "overwrite", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: await ctx(dir, t) }),
        (error: unknown) =>
          error instanceof Error &&
          rejectsArgument(field, /encoded losslessly/)(error) &&
          !("publication" in error),
      );
      assert.equal(await readFile(path, "utf8"), "original\n");
    }
    assert.deepEqual(events, []);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ambiguous recovery bounds candidate lists and never claims content identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-candidates-"));
  try {
    const path = join(dir, "file.txt");
    const lines = Array.from({ length: 100 }, () => "same");
    lines[49] = "different";
    await writeFile(path, lines.join("\n"));
    const failure = await invoke(
      makeEditOverride(dir, DEFAULT_CONFIG),
      "ambiguous",
      {
        path,
        edits: Array.from({ length: 1000 }, () => ({
          op: "delete",
          anchor: `50#${computeLineHash(50, "same", 4)}`,
        })),
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.equal(failure.isError, true);
    assertFailureByteBudgets(text(failure));
    const report = reportOf(failure);
    assert.ok(
      report?.failures?.every((entry) => entry.result === "ambiguous" && entry.omittedCandidates),
    );
    assert.doesNotMatch(text(failure), /same content/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NUL arguments are rejected before Fusion for all mutation tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-nul-"));
  try {
    const path = join(dir, "file.txt");
    await writeFile(path, "original\n");
    let commands = 0;
    const events: string[] = [];
    const fusion = createActionFusionExecutor(
      async () => {
        commands++;
        return { status: "succeeded", output: "unexpected" };
      },
      (event) => events.push(event.command),
    );
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: { path, edits: [{ op: "append", body: ["\0"] }], then_run: { command: "check" } },
        field: "edits[0].body[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ find: "original", replace: "\0" }],
          then_run: { command: "check" },
        },
        field: "replacements[0].replace",
      },
      {
        tool: makeWriteOverride(dir, fusion),
        args: { path, content: "\0", mode: "overwrite", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: await ctx(dir, t) }),
        (error: unknown) =>
          error instanceof Error &&
          rejectsArgument(field, /NUL/)(error) &&
          !("publication" in error),
      );
      assert.equal(await readFile(path, "utf8"), "original\n");
    }
    assert.deepEqual(events, []);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fusion skips the command when a replacement produces unencodable text", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-derived-unicode-"));
  try {
    const path = join(dir, "file.txt");
    const before = "😀\n";
    await writeFile(path, before);
    let commands = 0;
    const events: string[] = [];
    const fusion = createActionFusionExecutor(
      async () => {
        commands++;
        return { status: "succeeded", output: "unexpected" };
      },
      (event) => events.push(event.command),
    );
    const result = await callTool(
      makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
      {
        path,
        replacements: [{ find: "^.", replace: "x", regex: true }],
        then_run: { command: "check" },
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(result.isError, true);
    assert.equal(reportOf(result)?.error, "INVALID_UNICODE");
    assert.equal(reportOf(result)?.publication, "NOT_PUBLISHED");
    assert.equal(reportOf(result)?.then_run?.status, "skipped");
    assert.deepEqual(events, ["waiting", "skipped"]);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("result generation failure → preserves publication and cause", () => {
  for (const publication of ["NOT_PUBLISHED", "PUBLISHED", "UNKNOWN"] as const) {
    const cause = new Error("render failed");
    assert.throws(
      () =>
        postProcessMutation(publication, () => {
          throw cause;
        }),
      (error: any) =>
        error instanceof FileMutationError &&
        error.stage === "post_process" &&
        error.publication === publication &&
        error.cause === cause,
    );
  }
});

type Fusion = Parameters<typeof makeWriteOverride>[1];
const noOpCases = [
  {
    makeTool: (cwd: string, fusion?: Fusion) => makeEditOverride(cwd, DEFAULT_CONFIG, fusion),
    params: {
      edits: [
        {
          op: "replace",
          anchor: `1#${computeLineHash(1, "same", DEFAULT_CONFIG.hashLen)}`,
          body: ["same"],
        },
      ],
    },
  },
  {
    makeTool: (cwd: string, fusion?: Fusion) => makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    params: { replacements: [{ find: "same", replace: "same" }] },
  },
  { makeTool: makeWriteOverride, params: { content: "same\n", mode: "overwrite" } },
];

test("all mutation tools succeed without rewriting on no-op, with and without Fusion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-noop-"));
  try {
    for (const { makeTool, params } of noOpCases) {
      for (const mode of ["standalone", "fusion", "command"]) {
        const path = join(dir, "same.txt");
        await writeFile(path, "same\n");
        const before = await stat(path);
        let commands = 0;
        const fusion = createActionFusionExecutor(async () => {
          commands++;
          return { status: "succeeded", output: "checked" };
        });
        const tool: any = makeTool(dir, mode === "standalone" ? undefined : fusion);
        const result = await invoke(
          tool,
          tool.name,
          { path, ...params, ...(mode === "command" ? { then_run: { command: "check" } } : {}) },
          undefined,
          undefined,
          await ctx(dir, t),
        );
        assert.equal(reportOf(result)?.publication, "NOT_PUBLISHED");
        assert.equal(result.details.publication, "NOT_PUBLISHED");
        const revision = byteRevision(Buffer.from("same\n"));
        for (const key of ["baseRevision", "publishedRevision", "observedRevision"])
          assert.equal(result.details[key], revision);
        assert.equal("revision" in result.details, false);
        assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
        assert.equal(commands, mode === "command" ? 1 : 0);
        if (mode !== "standalone") {
          assert.equal(
            result.details.actionFusion.command,
            mode === "command" ? "succeeded" : "not_requested",
          );
          assert.equal(result.details.actionFusion.freshness, "unchanged");
        }
        const after = await stat(path);
        assert.deepEqual(
          [after.ino, after.mtimeMs, after.ctimeMs],
          [before.ino, before.mtimeMs, before.ctimeMs],
        );
        assert.equal(await readFile(path, "utf8"), "same\n");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-op Fusion still detects external changes and reports command failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-noop-fusion-"));
  try {
    for (const { makeTool, params } of noOpCases) {
      for (const scenario of ["before", "during", "failed"]) {
        const path = join(dir, "same.txt");
        await writeFile(path, "same\n");
        let commands = 0;
        const fusion = createActionFusionExecutor(
          async () => {
            commands++;
            if (scenario === "failed") throw new Error("check failed");
            await writeFile(path, "external\n");
            return { status: "succeeded", output: "done" };
          },
          (progress) => {
            if (
              scenario === "before" &&
              progress.mutationCompleted &&
              progress.command === "waiting"
            )
              writeFileSync(path, "external\n");
          },
        );
        const tool: any = makeTool(dir, fusion);
        const result = await invoke(
          tool,
          tool.name,
          { path, ...params, then_run: { command: "check" } },
          undefined,
          undefined,
          await ctx(dir, t),
        );
        assert.equal(result.details.publication, "NOT_PUBLISHED");
        assert.equal(commands, scenario === "before" ? 0 : 1);
        assert.equal(
          result.details.actionFusion.command,
          scenario === "before" ? "skipped" : scenario === "failed" ? "failed" : "succeeded",
        );
        assert.equal(
          result.details.actionFusion.freshness,
          scenario === "failed" ? "unchanged" : "changed",
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

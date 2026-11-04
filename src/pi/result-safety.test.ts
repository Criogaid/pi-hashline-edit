import { rejectsArgument } from "./argument-error.testing.ts";
import { computeLineHash } from "../core/hash.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outputBudgetsFor } from "./budgets.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { decodeReport, reportOf } from "./report.ts";
import { REREAD } from "./report-schema.ts";
import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";

const text = (result: Pick<AgentToolResult<unknown>, "content">): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

const anchorBudget = outputBudgetsFor(4096);
const anchorBatchSize: unknown = Reflect.get(
  makeEditOverride(process.cwd(), DEFAULT_CONFIG).parameters.properties.edits,
  "maxItems",
);
assert.ok(typeof anchorBatchSize === "number");

function assertFailureByteBudgets(message: string): void {
  const report = decodeReport(message, "edit");
  assert.ok(report);
  assert.equal(report.error, "ANCHOR_MISMATCH");
  assert.ok(report.failures && report.failures.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(report.failures)) <= anchorBudget.blockBytes);
  assert.equal(report.failures.length + (report.omittedFailures ?? 0), anchorBatchSize);
  assert.ok(report.omittedFailures);
  assert.ok(report.next?.includes("intended target"));
  if (report.candidateNeighborhoods) {
    const rows = report.candidateNeighborhoods.flatMap((group) => group.rows);
    assert.ok(rows.length > 0);
    assert.ok(Buffer.byteLength(rows.join("\n")) + 1 <= anchorBudget.blockBytes);
  }
}

test("edit and replace commands change or remove the file → withhold anchors and report freshness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-result-"));
  try {
    const context = await ctx(dir, t);
    for (const toolName of ["edit", "replace"] as const) {
      for (const state of ["changed", "missing", "unknown"] as const) {
        for (const fails of [false, true]) {
          const path = join(dir, `${toolName}-${state}-${fails}.txt`);
          await writeFile(path, "before\n");
          const updates: AgentToolResult<unknown>[] = [];
          const fusion = createActionFusionExecutor(
            async (_id, _input, _signal, _ctx, onUpdate) => {
              if (state === "changed") await writeFile(path, "command output\n");
              else {
                await rm(path);
                if (state === "unknown") await mkdir(path);
              }
              onUpdate?.({ content: [{ type: "text", text: "progress" }], details: undefined });
              if (fails) throw new Error("command failed");
              return { status: "succeeded", result: { content: [{ type: "text", text: "done" }] } };
            },
          );
          const tool =
            toolName === "edit"
              ? makeEditOverride(dir, DEFAULT_CONFIG, fusion)
              : makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
          const args =
            toolName === "edit"
              ? {
                  edits: [
                    {
                      action: "replace",
                      anchor: `1#${computeLineHash(1, "before", DEFAULT_CONFIG.hashLen)}`,
                      body: ["after"],
                    },
                  ],
                }
              : { replacements: [{ literal: true, find: "before", replace: "after" }] };
          const result = await callTool(
            tool,
            { path, ...args, then_run: { command: "check" } },
            {
              onUpdate: (update: AgentToolResult<unknown>) => updates.push(update),
              ctx: context,
            },
          );
          assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
          const report = reportOf(result, toolName);
          assert.equal(report?.freshness, state);
          assert.equal(report?.publication, "PUBLISHED");
          assert.equal(report?.next, REREAD);
          assert.equal(report?.then_run?.status, fails ? "failed" : "succeeded");
          if (fails) assert.equal(report?.then_run?.output, "command failed");
          assert.equal(result.content.length, 1);
          assert.ok(updates.length > 0);
          for (const update of updates)
            assert.doesNotMatch(text(update), /Updated anchors|\d+#[0-9A-Z]+│/);
          if (state === "changed") assert.equal(await readFile(path, "utf8"), "command output\n");
          else if (state === "missing") await assert.rejects(stat(path), { code: "ENOENT" });
          else assert.equal((await stat(path)).isDirectory(), true);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress callback failures → preserve publication and allow the command", async (t) => {
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
          return { status: "succeeded", result: { content: [{ type: "text", text: "done" }] } };
        },
        callback === "reporter" ? fail : undefined,
      );
      const path = join(dir, callback);
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        {
          path,
          content: "saved\n",
          mode: "create",
          then_run: { command: "check" },
        },
        { onUpdate: callback === "update" ? fail : undefined, ctx: await ctx(dir, t) },
      );
      assert.equal(commands, 1);
      assert.equal(await readFile(path, "utf8"), "saved\n");
      assert.equal(reportOf(result, "write")?.publication, "PUBLISHED");
      assert.equal(reportOf(result, "write")?.then_run?.status, "succeeded");
      assert.match(text(result), /display unavailable/);
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
    const failure = await callTool(
      makeEditOverride(dir, DEFAULT_CONFIG, undefined, () => anchorBudget),
      {
        path,
        edits: Array.from({ length: anchorBatchSize }, () => ({
          action: "delete",
          anchor: "1#XXXX",
        })),
      },
      { ctx: await ctx(dir, t) },
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
        return { status: "succeeded", result: { content: [{ type: "text", text: "done" }] } };
      },
      (event) => events.push(event.command),
    );
    const path = join(dir, "file.txt");
    await writeFile(path, "original\n");
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          edits: [{ action: "append", body: ["\ud800"] }],
          then_run: { command: "check" },
        },
        field: "edits[0].body[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ literal: true, find: "original", replace: "\udfff" }],
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
    const failure = await callTool(
      makeEditOverride(dir, DEFAULT_CONFIG, undefined, () => anchorBudget),
      {
        path,
        edits: Array.from({ length: anchorBatchSize }, () => ({
          action: "delete",
          anchor: `50#${computeLineHash(50, "same", 4)}`,
        })),
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(failure.isError, true);
    assertFailureByteBudgets(text(failure));
    const report = reportOf(failure, "edit");
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
        return { status: "succeeded", result: { content: [{ type: "text", text: "unexpected" }] } };
      },
      (event) => events.push(event.command),
    );
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: { path, edits: [{ action: "append", body: ["\0"] }], then_run: { command: "check" } },
        field: "edits[0].body[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ literal: true, find: "original", replace: "\0" }],
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
        return { status: "succeeded", result: { content: [{ type: "text", text: "unexpected" }] } };
      },
      (event) => events.push(event.command),
    );
    const result = await callTool(
      makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
      {
        path,
        replacements: [{ find: "^.", replace: "x", literal: false }],
        then_run: { command: "check" },
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(result.isError, true);
    assert.equal(reportOf(result, "replace")?.error, "INVALID_UNICODE");
    assert.equal(reportOf(result, "replace")?.publication, "NOT_PUBLISHED");
    assert.equal(reportOf(result, "replace")?.then_run?.status, "skipped");
    assert.deepEqual(events, ["waiting", "skipped"]);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("result generation fails after a real mutation → preserves publication and cause", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-result-generation-"));
  try {
    for (const content of ["before\n", "after\n"]) {
      const path = join(dir, "file.txt");
      await writeFile(path, "before\n");
      const cause = new Error("render failed");
      const context = await ctx(dir, t);
      const nativeOpen = fs.open;
      const nativeReplace = String.prototype.replace;
      const readsBeforeDiff = content === "before\n" ? 2 : 3;
      let targetReads = 0;
      let injected = false;
      let commands = 0;
      const fusion = createActionFusionExecutor(async () => {
        commands++;
        return { status: "succeeded", result: { content: [] } };
      });
      try {
        t.mock.method(fs, "open", async (...args: Parameters<typeof nativeOpen>) => {
          if (String(args[0]) === path) targetReads++;
          return nativeOpen(...args);
        });
        syncBuiltinESMExports();
        // Only fail diff normalization after the commit's final target read.
        t.mock.method(
          String.prototype,
          "replace",
          function (this: string, ...args: Parameters<typeof nativeReplace>) {
            if (!injected && targetReads === readsBeforeDiff && String(this) === content) {
              injected = true;
              throw cause;
            }
            return nativeReplace.apply(this, args);
          },
        );
        const result = await callTool(
          makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
          {
            path,
            replacements: [{ literal: true, find: "before\n", replace: content }],
            then_run: { command: "check" },
          },
          { ctx: context },
        );
        const report = reportOf(result, "replace");
        assert.equal(injected, true, `diff injection after ${targetReads} target reads`);
        assert.equal(result.isError, true);
        assert.equal(report?.error, "POST_PROCESS_FAILED");
        assert.ok(result.details);
        assert.equal(Reflect.get(result.details, "diff"), undefined);
        assert.equal(report?.publication, content === "before\n" ? "NOT_PUBLISHED" : "PUBLISHED");
        assert.deepEqual(report?.cause, { message: cause.message });
        assert.equal(report?.then_run?.status, "skipped");
        assert.equal(commands, 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Fusion = Parameters<typeof makeWriteOverride>[1];
const noOpCases = [
  {
    makeTool: (cwd: string, fusion?: Fusion) => makeEditOverride(cwd, DEFAULT_CONFIG, fusion),
    params: {
      edits: [
        {
          action: "replace",
          anchor: `1#${computeLineHash(1, "same", DEFAULT_CONFIG.hashLen)}`,
          body: ["same"],
        },
      ],
    },
  },
  {
    makeTool: (cwd: string, fusion?: Fusion) => makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    params: { replacements: [{ literal: true, find: "same", replace: "same" }] },
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
          return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
        });
        const tool = makeTool(dir, mode === "standalone" ? undefined : fusion);
        const result = await callTool(
          tool,
          { path, ...params, ...(mode === "command" ? { then_run: { command: "check" } } : {}) },
          { ctx: await ctx(dir, t) },
        );
        assert.equal(reportOf(result, tool.name)?.publication, "NOT_PUBLISHED");
        assert.ok(result.details);
        assert.equal(Reflect.get(result.details, "diff"), tool.name === "write" ? undefined : "");
        assert.equal(reportOf(result, tool.name)?.freshness, undefined);
        assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
        assert.equal(commands, mode === "command" ? 1 : 0);
        assert.equal(
          reportOf(result, tool.name)?.then_run?.status,
          mode === "command" ? "succeeded" : undefined,
        );
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

test("line movement changes only line endings → publishes with an empty diff and still checks Fusion freshness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-empty-diff-"));
  try {
    const context = await ctx(dir, t);
    for (const mode of ["standalone", "fusion", "command", "stale"] as const) {
      const path = join(dir, `${mode}.txt`);
      await writeFile(path, "same\r\nsame\n");
      let commands = 0;
      const fusion = createActionFusionExecutor(
        async () => {
          commands++;
          assert.equal(await readFile(path, "utf8"), "same\nsame\r\n");
          return { status: "succeeded", result: { content: [] } };
        },
        (progress) => {
          if (mode === "stale" && progress.mutationCompleted && progress.command === "waiting")
            writeFileSync(path, "external\n");
        },
      );
      const result = await callTool(
        makeEditOverride(dir, DEFAULT_CONFIG, mode === "standalone" ? undefined : fusion),
        {
          path,
          edits: [
            {
              action: "move",
              anchor: `1#${computeLineHash(1, "same", DEFAULT_CONFIG.hashLen)}`,
              after: `2#${computeLineHash(2, "same", DEFAULT_CONFIG.hashLen)}`,
            },
          ],
          ...(["command", "stale"].includes(mode) ? { then_run: { command: "check" } } : {}),
        },
        { ctx: context },
      );
      const report = reportOf(result, "edit");
      assert.equal(result.isError, undefined);
      assert.equal(Reflect.get(result.details, "diff"), "");
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.freshness, mode === "stale" ? "changed" : undefined);
      assert.equal(
        report?.then_run?.status,
        mode === "command" ? "succeeded" : mode === "stale" ? "skipped" : undefined,
      );
      assert.equal(report?.next, mode === "stale" ? REREAD : undefined);
      assert.equal(commands, mode === "command" ? 1 : 0);
      assert.equal(
        await readFile(path, "utf8"),
        mode === "stale" ? "external\n" : "same\nsame\r\n",
      );
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
            return { status: "succeeded", result: { content: [{ type: "text", text: "done" }] } };
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
        const tool = makeTool(dir, fusion);
        const result = await callTool(
          tool,
          { path, ...params, then_run: { command: "check" } },
          { ctx: await ctx(dir, t) },
        );
        assert.equal(reportOf(result, tool.name)?.publication, "NOT_PUBLISHED");
        assert.equal(commands, scenario === "before" ? 0 : 1);
        assert.equal(
          reportOf(result, tool.name)?.then_run?.status,
          scenario === "before" ? "skipped" : scenario === "failed" ? "failed" : "succeeded",
        );
        assert.equal(
          reportOf(result, tool.name)?.freshness,
          scenario === "failed" ? undefined : "changed",
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

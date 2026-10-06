import { computeLineHash } from "../core/hash.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatKiB, MAX_BLOCK_BYTES } from "./budgets.ts";
import { createActionFusionExecutor, THEN_RUN_STALE } from "./action-fusion.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { byteRevision, FileMutationError } from "./file-commit.ts";
import {
  commitFreshness,
  finalizeMutation,
  postProcessMutation,
  staleTargetNotice,
  type MutationOutcome,
} from "./mutation-result.ts";
import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { publishedMutation } from "./mutation-outcome.testing.ts";

const KIB = formatKiB(MAX_BLOCK_BYTES);
const DIAGNOSTIC_TRUNCATED = new RegExp(`Diagnostic output truncated at ${KIB}`);
const ANCHOR_CHECK_TRUNCATED = new RegExp(
  `Anchor-check output truncated at ${KIB}; omitted entries are not implied matched`,
);
const ANCHORS_OMITTED = new RegExp(`additional anchors omitted: ${KIB} limit`);

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
  const checksAt = message.indexOf("\nInput-anchor checks (this snapshot):\n");
  const guidanceAt = message.indexOf("\nCheck the intended target before retrying;", checksAt);
  const neighborhoodsAt = message.indexOf("\nAmbiguous-candidate neighborhoods", checksAt);
  assert.ok(checksAt > 0 && guidanceAt > checksAt);
  assert.ok(Buffer.byteLength(message.slice(0, checksAt)) <= MAX_BLOCK_BYTES);
  assert.ok(
    Buffer.byteLength(
      message.slice(checksAt + 1, neighborhoodsAt < 0 ? guidanceAt : neighborhoodsAt),
    ) <= MAX_BLOCK_BYTES,
  );
  if (neighborhoodsAt >= 0) {
    const rows = message.slice(neighborhoodsAt, guidanceAt).match(/^\d+#[0-9A-Z]+│.*$/gm) ?? [];
    assert.ok(rows.length > 0);
    assert.ok(Buffer.byteLength(rows.join("\n")) + 1 <= MAX_BLOCK_BYTES);
  }
  assert.match(message, DIAGNOSTIC_TRUNCATED);
  assert.match(message, ANCHOR_CHECK_TRUNCATED);
  const checks = message.match(/^op \d+ \/ anchor \/ .* \/ mismatched$/gm) ?? [];
  assert.ok(checks.length > 40 && checks.length < 1000);
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
          return "done";
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
        assert.deepEqual(result.content[1], {
          type: "text",
          text: staleTargetNotice(THEN_RUN_STALE),
        });
        assert.equal(
          result.content.filter(
            (block: any) => block.type === "text" && block.text.includes(THEN_RUN_STALE),
          ).length,
          1,
        );
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
          return "done";
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
        thenRun: { command: "check" },
        mutate: async () => {
          throw new FileMutationError("post_process", "PUBLISHED", "original failure");
        },
        signal: undefined,
        ctx: await ctx(dir, t),
      }),
      (error: any) => error.publication === "PUBLISHED" && /original failure/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone and Fusion finalizers use commit freshness with or without anchors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-finalizer-"));
  try {
    for (const publication of ["PUBLISHED", "NOT_PUBLISHED"] as const) {
      for (const observedRevision of ["published", "external"]) {
        for (const anchors of [" ANCHOR", undefined]) {
          const mutation = {
            result: {
              content: [{ type: "text", text: "saved" }],
              details: {
                publication: "UNKNOWN",
                publishedRevision: "ignored",
                observedRevision: "ignored",
              },
            },
            commit: {
              publication,
              publishedRevision: "published",
              observedRevision,
              created: false,
            },
            anchors,
          } satisfies MutationOutcome<unknown>;
          const fresh = observedRevision === "published";
          assert.equal(commitFreshness(mutation.commit), fresh ? "unchanged" : "changed");
          const standalone = finalizeMutation(
            mutation,
            commitFreshness(mutation.commit) === "unchanged",
          );
          const fused = await createActionFusionExecutor()({
            toolCallId: "no-command",
            absolutePath: join(dir, "file"),
            thenRun: undefined,
            mutate: async () => mutation,
            signal: undefined,
            ctx: await ctx(dir, t),
          });
          const expectedContent = [{ type: "text", text: `saved${fresh ? (anchors ?? "") : ""}` }];
          if (!fresh) expectedContent.push({ type: "text", text: staleTargetNotice() });
          assert.deepEqual(standalone.content, expectedContent);
          assert.deepEqual(fused.content, expectedContent);
          assert.deepEqual(standalone.details, mutation.result.details);
          assert.deepEqual(fused.details, {
            ...mutation.result.details,
            actionFusion: {
              publication,
              command: "not_requested",
              freshness: fresh ? "unchanged" : "changed",
            },
          });
          assert.deepEqual(mutation.result.content, [{ type: "text", text: "saved" }]);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation anchor output and aggregate anchor diagnostics have byte budgets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-budget-"));
  try {
    const path = join(dir, "long.txt");
    const long = "界".repeat(100000);
    const changedLines = [long, ...Array.from({ length: 79 }, (_, index) => `changed ${index}`)];
    for (const name of ["edit", "replace"]) {
      await writeFile(path, "before\n");
      const result =
        name === "edit"
          ? await invoke(
              makeEditOverride(dir, DEFAULT_CONFIG),
              name,
              { path, edits: [{ op: "append", body: changedLines }] },
              undefined,
              undefined,
              await ctx(dir, t),
            )
          : await invoke(
              makeReplaceTool(dir, DEFAULT_CONFIG),
              name,
              { path, replacements: [{ find: "before", replace: changedLines.join("\n") }] },
              undefined,
              undefined,
              await ctx(dir, t),
            );
      const output = text(result);
      const firstLine = name === "edit" ? 2 : 1;
      assert.deepEqual(
        output.match(/^\d+#[0-9A-Z]+$/gm),
        changedLines.map((line, index) => {
          const position = firstLine + index;
          return `${position}#${computeLineHash(position, line, 4)}`;
        }),
      );
      assert.doesNotMatch(output, /omitted|truncated|│/i);
      assert.equal(
        await readFile(path, "utf8"),
        (name === "edit" ? "before\n" : "") + changedLines.join("\n") + "\n",
      );
      await writeFile(path, `remove\n${long}\n`);
      const deleted =
        name === "edit"
          ? await invoke(
              makeEditOverride(dir, DEFAULT_CONFIG),
              name,
              { path, edits: [{ op: "delete", anchor: `1#${computeLineHash(1, "remove", 4)}` }] },
              undefined,
              undefined,
              await ctx(dir, t),
            )
          : await invoke(
              makeReplaceTool(dir, DEFAULT_CONFIG),
              name,
              { path, replacements: [{ find: "remove\n", replace: "" }] },
              undefined,
              undefined,
              await ctx(dir, t),
            );
      const anchorStart = text(deleted).indexOf("\nUpdated anchors:");
      assert.ok(anchorStart >= 0);
      const anchorBlock = text(deleted).slice(anchorStart);
      assert.ok(Buffer.byteLength(anchorBlock) <= MAX_BLOCK_BYTES);
      assert.match(text(deleted), ANCHORS_OMITTED);
      assert.doesNotMatch(text(deleted), /^\d+#[0-9A-Z]+/m);
    }
    await writeFile(path, "current\n");
    await assert.rejects(
      invoke(
        makeEditOverride(dir, DEFAULT_CONFIG),
        "errors",
        {
          path,
          edits: Array.from({ length: 1000 }, () => ({ op: "delete", anchor: "1#XXXX" })),
        },
        undefined,
        undefined,
        await ctx(dir, t),
      ),
      (error: Error) => {
        assertFailureByteBudgets(error.message);
        assert.match(error.message, /omitted|truncated/i);
        return true;
      },
    );
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
        return "done";
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
        args: { path, content: "\ud800", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: await ctx(dir, t) }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith(`Invalid argument ${field}: INVALID_UNICODE:`) &&
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
    await assert.rejects(
      invoke(
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
      ),
      (error: Error) => {
        assertFailureByteBudgets(error.message);
        assert.match(error.message, /ambiguous checksum matches/);
        assert.match(error.message, /candidates omitted/);
        assert.doesNotMatch(error.message, /same content/);
        return true;
      },
    );
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
        return "unexpected";
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
        args: { path, content: "\0", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: await ctx(dir, t) }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith(`Invalid argument ${field}: UNSUPPORTED_TEXT: NUL`) &&
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
        return "unexpected";
      },
      (event) => events.push(event.command),
    );
    await assert.rejects(
      callTool(
        makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        {
          path,
          replacements: [{ find: "^.", replace: "x", regex: true }],
          then_run: { command: "check" },
        },
        { ctx: await ctx(dir, t) },
      ),
      (error: any) =>
        error.publication === "NOT_PUBLISHED" &&
        error.command === "skipped" &&
        /INVALID_UNICODE/.test(error.message),
    );
    assert.deepEqual(events, ["waiting", "skipped"]);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared result building preserves publication and appends anchors only to the summary", () => {
  for (const publication of ["NOT_PUBLISHED", "PUBLISHED", "UNKNOWN"] as const) {
    const cause = new Error("render failed");
    assert.throws(
      () =>
        postProcessMutation("replace", publication, () => {
          throw cause;
        }),
      (error: any) =>
        error instanceof FileMutationError &&
        error.stage === "post_process" &&
        error.publication === publication &&
        error.cause === cause,
    );
  }
  const result = {
    content: [
      { type: "text" as const, text: "summary" },
      { type: "text" as const, text: "command" },
    ],
    details: {},
  };
  const outcome = publishedMutation("saved", result, " ANCHOR");
  assert.deepEqual(
    finalizeMutation(outcome, true).content.map((block: any) => block.text),
    ["summary ANCHOR", "command"],
  );
  assert.deepEqual(finalizeMutation(outcome, false).content, [
    ...result.content,
    { type: "text", text: staleTargetNotice() },
  ]);
  assert.equal(result.content[0].text, "summary");
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
  { makeTool: makeWriteOverride, params: { content: "same\n" } },
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
          return "checked";
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
        assert.match(text(result), /no net change/);
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
            return "done";
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

test("mutation anchors omit unchanged positions across distant changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-anchor-delta-"));
  try {
    const before = Array.from({ length: 100 }, (_, index) => `row ${index + 1}`);
    const after = [...before];
    after[0] = "changed first";
    after[99] = "changed last";
    for (const name of ["edit", "replace"]) {
      const path = join(dir, `${name}.txt`);
      await writeFile(path, before.join("\r\n") + "\r\n");
      const result =
        name === "edit"
          ? await invoke(
              makeEditOverride(dir, DEFAULT_CONFIG),
              name,
              {
                path,
                edits: [
                  {
                    op: "replace",
                    anchor: `1#${computeLineHash(1, before[0], 4)}`,
                    end: `100#${computeLineHash(100, before[99], 4)}`,
                    body: after,
                  },
                ],
              },
              undefined,
              undefined,
              await ctx(dir, t),
            )
          : await invoke(
              makeReplaceTool(dir, DEFAULT_CONFIG),
              name,
              {
                path,
                replacements: [
                  { find: before[0] + "\r\n", replace: after[0] + "\r\n" },
                  { find: before[99], replace: after[99] },
                ],
              },
              undefined,
              undefined,
              await ctx(dir, t),
            );
      const returned = [...text(result).matchAll(/^(\d+#[0-9A-Z]+)/gm)].map((match) => match[1]);
      assert.deepEqual(returned, [
        `1#${computeLineHash(1, after[0], 4)}`,
        `100#${computeLineHash(100, after[99], 4)}`,
      ]);
      assert.doesNotMatch(text(result), /omitted/);
      // An omitted stable row keeps its old anchor; a changed row uses the returned anchor.
      await invoke(
        makeEditOverride(dir, DEFAULT_CONFIG),
        "chain",
        {
          path,
          edits: [
            {
              op: "replace",
              anchor: `50#${computeLineHash(50, before[49], 4)}`,
              body: ["stable anchor reused"],
            },
            { op: "replace", anchor: returned[1], body: ["fresh anchor reused"] },
          ],
        },
        undefined,
        undefined,
        await ctx(dir, t),
      );
      const final = (await readFile(path, "utf8")).split("\r\n");
      assert.equal(final[49], "stable anchor reused");
      assert.equal(final[99], "fresh anchor reused");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation anchors retain a deletion successor but omit stable rows and deleted EOF", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-anchor-delete-"));
  try {
    for (const name of ["edit", "replace"]) {
      for (const atEnd of [false, true]) {
        for (const ending of ["\n", "\r\n"]) {
          const path = join(dir, `${name}.txt`);
          const lines = atEnd ? ["a", "c", "remove"] : ["a", "remove", "c", "d"];
          await writeFile(path, lines.join(ending) + ending);
          const line = atEnd ? 3 : 2;
          const result =
            name === "edit"
              ? await invoke(
                  makeEditOverride(dir, DEFAULT_CONFIG),
                  name,
                  {
                    path,
                    edits: [
                      { op: "delete", anchor: `${line}#${computeLineHash(line, "remove", 4)}` },
                    ],
                  },
                  undefined,
                  undefined,
                  await ctx(dir, t),
                )
              : await invoke(
                  makeReplaceTool(dir, DEFAULT_CONFIG),
                  name,
                  { path, replacements: [{ find: "remove\n", replace: "" }] },
                  undefined,
                  undefined,
                  await ctx(dir, t),
                );
          const rows = text(result)
            .split("\n")
            .filter((row) => /^\d+#/.test(row));
          assert.deepEqual(rows, atEnd ? [] : [`2#${computeLineHash(2, "c", 4)}│c`]);
          assert.deepEqual(
            await readFile(path),
            Buffer.from(lines.filter((_, index) => index !== line - 1).join(ending) + ending),
          );
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation anchors retain deletion successor even when deleted line content matches the successor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-anchor-matching-delete-"));
  try {
    const path = join(dir, "edit.txt");
    const lines = ["a", "duplicate", "duplicate", "d"];
    await writeFile(path, lines.join("\n") + "\n");
    const tool = makeEditOverride(dir, DEFAULT_CONFIG);
    const result = await invoke(
      tool,
      "edit",
      {
        path,
        edits: [{ op: "delete", anchor: `2#${computeLineHash(2, "duplicate", 4)}` }],
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const rows = text(result)
      .split("\n")
      .filter((row) => /^\d+#/.test(row));
    assert.deepEqual(rows, [`2#${computeLineHash(2, "duplicate", 4)}│duplicate`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized deletion successors do not suppress later editable anchors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-skip-long-anchor-"));
  try {
    const path = join(dir, "fixture.txt");
    const long = "x".repeat(MAX_BLOCK_BYTES + 1);
    await writeFile(path, `remove\n${long}\nold\n`);
    const tool = makeEditOverride(dir, DEFAULT_CONFIG);
    const result = await invoke(
      tool,
      "skip",
      {
        path,
        edits: [
          { op: "delete", anchor: `1#${computeLineHash(1, "remove", 4)}` },
          { op: "replace", anchor: `3#${computeLineHash(3, "old", 4)}`, body: ["new"] },
        ],
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const output = text(result);
    assert.doesNotMatch(output, /^1#[0-9A-Z]+/m);
    const anchor = output.match(/^2#[0-9A-Z]+$/m)?.[0];
    assert.equal(anchor, `2#${computeLineHash(2, "new", 4)}`);
    assert.match(output, ANCHORS_OMITTED);
    assert.ok(
      Buffer.byteLength(output.slice(output.indexOf("\nUpdated anchors:"))) <= MAX_BLOCK_BYTES,
    );
    await invoke(
      tool,
      "retry",
      { path, edits: [{ op: "replace", anchor, body: ["verified"] }] },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.equal(await readFile(path, "utf8"), `${long}\nverified\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

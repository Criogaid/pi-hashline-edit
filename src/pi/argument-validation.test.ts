import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";

const invalidCommand = { command: "", timeout: 0 };
const anchorHash = "A".repeat(DEFAULT_CONFIG.hashLen);
const cases = [
  {
    name: "read",
    make: (cwd: string, _fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeReadOverride(cwd, DEFAULT_CONFIG),
    args: { offset: -1, limit: 0 },
    diagnostics: [
      new RegExp(`\\n  - offset:.*>= ${POSITIVE_SAFE_INTEGER.minimum}`),
      new RegExp(`\\n  - limit:.*>= ${POSITIVE_SAFE_INTEGER.minimum}`),
    ],
  },
  {
    name: "grep",
    make: (cwd: string, _fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeGrepOverride(cwd, DEFAULT_CONFIG),
    args: { pattern: [], literal: true, limit: 0, context: -1 },
    diagnostics: [/\n  - pattern:/, /\n  - limit:/, /\n  - context:/],
  },
  {
    name: "edit",
    make: (cwd: string, fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeEditOverride(cwd, DEFAULT_CONFIG, fusion),
    args: {
      edits: [
        { op: "replace", anchor: `1#${anchorHash}`, body: [] },
        { op: "append", body: ["bad\0", "bad\ud800"] },
        { op: "delete", anchor: `${Number.MAX_SAFE_INTEGER + 1}#${anchorHash}`, end: "1#A" },
        { op: "append", body: [] },
      ],
      then_run: invalidCommand,
    },
    diagnostics: [
      /Invalid argument edits\[0\]\.body:.*delete/,
      /Invalid argument edits\[1\]\.body\[0\]: UNSUPPORTED_TEXT:/,
      /Invalid argument edits\[1\]\.body\[1\]: INVALID_UNICODE:/,
      /Invalid argument edits\[2\]\.anchor:.*safe integer/,
      /Invalid argument edits\[2\]\.end:.*hash/,
      /Invalid argument edits\[3\]\.body:.*empty/,
      /\n  - then_run.command:/,
      /\n  - then_run.timeout:/,
    ],
  },
  {
    name: "replace",
    make: (cwd: string, fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    args: {
      replacements: [
        { find: "(", replace: "bad\0", regex: true },
        { find: "[", replace: "bad\ud800", regex: true },
      ],
      then_run: invalidCommand,
    },
    diagnostics: [
      /Invalid argument replacements\[0\]\.replace: UNSUPPORTED_TEXT:/,
      /Invalid argument replacements\[0\]\.find: invalid regex/,
      /Invalid argument replacements\[1\]\.replace: INVALID_UNICODE:/,
      /Invalid argument replacements\[1\]\.find: invalid regex/,
      /\n  - then_run.command:/,
      /\n  - then_run.timeout:/,
    ],
  },
  {
    name: "write",
    make: (cwd: string, fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeWriteOverride(cwd, fusion),
    args: { content: "bad\0", mode: "invalid", then_run: invalidCommand },
    diagnostics: [
      /Invalid argument content: UNSUPPORTED_TEXT:/,
      /\n  - mode:/,
      /\n  - then_run.command:/,
      /\n  - then_run.timeout:/,
    ],
  },
] as const;

for (const scenario of cases) {
  test(`${scenario.name} receives independent argument errors → reports them together without effects`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "hashline-arguments-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const path = join(cwd, "target.txt");
    const original = "original\n";
    await writeFile(path, original);
    let commandRuns = 0;
    const fusion = createActionFusionExecutor(async () => {
      commandRuns++;
      return { status: "succeeded", output: "ran" };
    });
    const tool = scenario.make(cwd, fusion);
    // These values round-trip through JSON exactly as model tool arguments do.
    const args: unknown = JSON.parse(JSON.stringify({ path, ...scenario.args, unexpected: true }));
    await assert.rejects(callTool(tool, args), (error: Error) => {
      for (const diagnostic of [...scenario.diagnostics, /\n  - unexpected:/]) {
        assert.match(error.message, diagnostic);
      }
      assert.doesNotMatch(error.message, /\n  - path:/);
      assert.doesNotMatch(error.message, /Received arguments:\n/);
      const echoedArgs = [...error.message.matchAll(/^Received arguments: (.+)$/gm)].map((match) =>
        JSON.parse(match[1]),
      );
      assert.deepEqual(echoedArgs.at(-1), { unexpected: true });
      return true;
    });
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(commandRuns, 0);
  });
}

test("argument diagnostics exceed the shared budget → rejection labels omitted text", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const edits = Array.from({ length: MAX_BLOCK_BYTES }, () => ({ op: "append", body: [] }));
  await assert.rejects(callTool(tool, { path: "", edits }), (error: Error) => {
    assert.ok(Buffer.byteLength(error.message) <= MAX_BLOCK_BYTES);
    assert.match(error.message, /Invalid argument edits\[0\]\.body:/);
    assert.match(error.message, /Diagnostics truncated/);
    return true;
  });
});

test("known edit operations with empty bodies → report the actionable issue once", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const op of ["replace", "insert_after", "insert_before", "append", "prepend"]) {
    const operation = {
      op,
      ...(op === "append" || op === "prepend" ? {} : { anchor: `22#${anchorHash}` }),
      body: [],
    };
    await assert.rejects(
      callTool(tool, { path: "unused.txt", edits: [operation] }),
      (error: Error) => {
        assert.match(error.message, /Invalid argument edits\[0\]\.body:.*empty/);
        assert.doesNotMatch(
          error.message,
          /Validation failed|schema is false|must be equal to constant|additional errors may remain/,
        );
        return true;
      },
    );
  }
});

test("known edit branch has independent errors → report them without unrelated branches", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG, createActionFusionExecutor());
  await assert.rejects(
    callTool(tool, {
      path: "unused.txt",
      edits: [
        { op: "insert_after", body: [], extra: true },
        { op: "delete", anchor: `2#${anchorHash}`, body: ["wrong"] },
        { op: "replace", anchor: "bad", body: ["valid"] },
      ],
      then_run: invalidCommand,
      unexpected: true,
    }),
    (error: Error) => {
      assert.match(error.message, /Invalid argument edits\[0\]\.body:/);
      for (const field of [
        "edits.0.anchor",
        "edits.0.extra",
        "edits.1.body",
        "edits.2.anchor",
        "then_run.command",
        "then_run.timeout",
        "unexpected",
      ]) {
        assert.ok(error.message.includes(`- ${field}:`), error.message);
      }
      assert.doesNotMatch(error.message, /- edits\.\d+\.op:|- edits\.0\.body:/);
      return true;
    },
  );
});

test("unknown edit operation → retain schema rejection instead of guessing a branch", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, {
      path: "unused.txt",
      edits: [{ op: "unknown", anchor: `1#${anchorHash}`, body: ["valid"] }],
    }),
    /Validation failed for tool "edit":[\s\S]*edits\.0\.op:/,
  );
});

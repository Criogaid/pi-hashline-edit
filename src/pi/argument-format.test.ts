import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { callTool } from "./tool-call.testing.ts";
import { argumentError } from "./argument-error.testing.ts";

const cwd = process.cwd();

test("all tools receive invalid arguments → return field diagnostics without an argument copy or execution", async () => {
  const cases = [
    {
      tool: makeEditOverride(cwd, DEFAULT_CONFIG),
      args: { path: "unused", edits: [{ op: "append", body: [] }] },
    },
    { tool: makeReadOverride(cwd, DEFAULT_CONFIG), args: { path: "unused", limit: 0 } },
    { tool: makeGrepOverride(cwd, DEFAULT_CONFIG), args: { pattern: "", literal: true } },
    { tool: makeWriteOverride(cwd), args: { path: "unused", content: "bad\0", mode: "create" } },
    {
      tool: makeReplaceTool(cwd, DEFAULT_CONFIG),
      args: { path: "unused", replacements: [{ find: "a", replace: "bad\0" }] },
    },
  ];
  for (const { tool, args } of cases) {
    let executed = false;
    await assert.rejects(
      callTool(
        {
          ...tool,
          execute: async () => {
            executed = true;
            return { content: [] };
          },
        },
        args,
      ),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.tool, tool.name);
        assert.ok(result.issues.length > 0);
        assert.equal(Object.hasOwn(result, "arguments"), false);
        assert.equal(Object.hasOwn(result, "argumentsOmitted"), false);
        return true;
      },
    );
    assert.equal(executed, false);
  }
});

test("Pi prepares a singleton operation → semantic and schema paths resolve to the prepared array", async () => {
  const tool = makeEditOverride(cwd, DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused", edits: { op: "insert_after", body: [] } }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        result.issues.map((issue) => issue.field),
        ["edits[0].body", "edits[0].anchor"],
      );
      return true;
    },
  );
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), { path: "unused", offset: "1", limit: 0 }),
    (error: unknown) => {
      assert.deepEqual(
        argumentError(error).issues.map((issue) => issue.field),
        ["limit"],
      );
      return true;
    },
  );
});

test("JSON diagnostics exceed the budget → retain whole opening and closing issues and label omissions", async () => {
  const edits = Array.from({ length: DEFAULT_OUTPUT_BUDGETS.blockBytes }, () => ({
    op: "append",
    body: [],
  }));
  await assert.rejects(
    callTool(makeEditOverride(cwd, DEFAULT_CONFIG), { path: "", edits }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(
        error instanceof Error &&
          Buffer.byteLength(error.message) <= DEFAULT_OUTPUT_BUDGETS.blockBytes,
      );
      assert.equal(result.issues[0].field, "edits[0].body");
      assert.equal(result.issues.at(-1)?.field, "path");
      assert.ok((result.omittedIssues ?? 0) > 0);
      assert.equal(result.issues.length + (result.omittedIssues ?? 0), edits.length + 1);
      return true;
    },
  );
});

test("a reason contains an oversized anchor → keep its cause and recovery instruction inside valid JSON", async () => {
  const anchor = `${"9".repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes)}#${"A".repeat(DEFAULT_CONFIG.hashLen)}`;
  await assert.rejects(
    callTool(makeEditOverride(cwd, DEFAULT_CONFIG), {
      path: "unused",
      edits: [{ op: "delete", anchor }],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(
        error instanceof Error &&
          Buffer.byteLength(error.message) <= DEFAULT_OUTPUT_BUDGETS.blockBytes,
      );
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "edits[0].anchor");
      assert.match(result.issues[0].reason, /^line number/);
      assert.match(result.issues[0].fix ?? "", /Copy a complete.*latest tool result/);
      assert.doesNotMatch(result.issues[0].reason, /Read|grep|Copy/);
      return true;
    },
  );
});

test("cyclic arguments → retain the field diagnostic", async () => {
  const args: { path: string; self?: unknown } = { path: "unused" };
  args.self = args;
  await assert.rejects(callTool(makeReadOverride(cwd, DEFAULT_CONFIG), args), (error: unknown) => {
    const result = argumentError(error);
    assert.equal(result.issues[0].field, "self");
    assert.match(result.issues[0].reason, /not allowed/);
    return true;
  });
});

test("Pi cannot clone an argument → report the original cause in the same JSON envelope", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), { path: "unused", extra: () => undefined }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues[0].field, "$");
      assert.match(result.issues[0].reason, /clone/i);
      return true;
    },
  );
});

test("a non-finite numeric argument → reports its field without JSON encoding the value", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), { path: "unused", limit: Infinity }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues[0].field, "limit");
      return true;
    },
  );
});

test("a property path exceeds the JSON budget → omit the whole issue and keep another field", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), {
      path: "",
      ['"中🙂'.repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes)]: true,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(
        error instanceof Error &&
          Buffer.byteLength(error.message) <= DEFAULT_OUTPUT_BUDGETS.blockBytes,
      );
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "path");
      assert.equal(result.omittedIssues, 1);
      return true;
    },
  );
});

test("a large valid argument → leaves the diagnostic budget for invalid fields", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), {
      path: '"中🙂'.repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes),
      limit: 0,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(
        error instanceof Error &&
          Buffer.byteLength(error.message) <= DEFAULT_OUTPUT_BUDGETS.blockBytes,
      );
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "limit");
      assert.equal(result.omittedIssues, undefined);
      return true;
    },
  );
});

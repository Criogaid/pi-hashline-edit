import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestSession } from "../testing/session.testing.ts";
import { registerForgetTool } from "./forget-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import { callTool } from "./tool-call.testing.ts";
import { argumentError } from "./argument-error.testing.ts";

const cwd = process.cwd();

test("all six tools receive invalid arguments → return JSON without execution", async (t) => {
  const { session } = await openTestSession(t, {
    tools: ["forget"],
    configure(pi) {
      registerForgetTool(pi);
    },
  });
  const forget = session.getToolDefinition("forget");
  assert.ok(forget);
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
    { tool: forget, args: { ids: [] } },
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
        assert.deepEqual(result.arguments, args);
        return true;
      },
    );
    assert.equal(executed, false);
  }
});

test("Pi prepares a singleton operation → semantic and schema paths resolve to the displayed array", async () => {
  const tool = makeEditOverride(cwd, DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused", edits: { op: "insert_after", body: [] } }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        result.issues.map((issue) => issue.field),
        ["edits[0].body", "edits[0].anchor"],
      );
      assert.deepEqual(result.arguments, {
        path: "unused",
        edits: [{ op: "insert_after", body: [] }],
      });
      return true;
    },
  );
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), { path: "unused", offset: "1", limit: 0 }),
    (error: unknown) => {
      assert.deepEqual(argumentError(error).arguments, { path: "unused", offset: 1, limit: 0 });
      return true;
    },
  );
});

test("JSON diagnostics exceed the budget → retain whole opening and closing issues and label omissions", async () => {
  const edits = Array.from({ length: MAX_BLOCK_BYTES }, () => ({ op: "append", body: [] }));
  await assert.rejects(
    callTool(makeEditOverride(cwd, DEFAULT_CONFIG), { path: "", edits }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(error instanceof Error && Buffer.byteLength(error.message) <= MAX_BLOCK_BYTES);
      assert.equal(result.issues[0].field, "edits[0].body");
      assert.equal(result.issues.at(-1)?.field, "path");
      assert.equal(result.argumentsOmitted, true);
      assert.ok((result.omittedIssues ?? 0) > 0);
      assert.equal(result.issues.length + (result.omittedIssues ?? 0), edits.length + 1);
      return true;
    },
  );
});

test("a reason contains an oversized anchor → keep its cause and recovery instruction inside valid JSON", async () => {
  const anchor = `${"9".repeat(MAX_BLOCK_BYTES)}#${"A".repeat(DEFAULT_CONFIG.hashLen)}`;
  await assert.rejects(
    callTool(makeEditOverride(cwd, DEFAULT_CONFIG), {
      path: "unused",
      edits: [{ op: "delete", anchor }],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(error instanceof Error && Buffer.byteLength(error.message) <= MAX_BLOCK_BYTES);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "edits[0].anchor");
      assert.match(result.issues[0].reason, /^line number/);
      assert.match(result.issues[0].reason, /Diagnostics truncated/);
      assert.match(result.issues[0].reason, /copy a complete.*latest tool result/);
      return true;
    },
  );
});

test("cyclic arguments still have a field diagnostic → label the unencodable argument copy", async () => {
  const args: { path: string; self?: unknown } = { path: "unused" };
  args.self = args;
  await assert.rejects(callTool(makeReadOverride(cwd, DEFAULT_CONFIG), args), (error: unknown) => {
    const result = argumentError(error);
    assert.equal(result.argumentsOmitted, true);
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
      assert.equal(result.argumentsOmitted, true);
      assert.equal(result.issues[0].field, "$");
      assert.match(result.issues[0].reason, /clone/i);
      return true;
    },
  );
});

test("an invalid numeric value is not representable in JSON → omit the copy instead of displaying null", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), { path: "unused", limit: Infinity }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.argumentsOmitted, true);
      assert.equal(Object.hasOwn(result, "arguments"), false);
      assert.equal(result.issues[0].field, "limit");
      return true;
    },
  );
});

test("a property path exceeds the JSON budget → omit the whole issue and keep another field", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), {
      path: "",
      ['"中🙂'.repeat(MAX_BLOCK_BYTES)]: true,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(error instanceof Error && Buffer.byteLength(error.message) <= MAX_BLOCK_BYTES);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "path");
      assert.equal(result.omittedIssues, 1);
      assert.equal(result.argumentsOmitted, true);
      return true;
    },
  );
});

test("the argument copy uses escaping and multibyte text → count serialized bytes before omitting it", async () => {
  await assert.rejects(
    callTool(makeReadOverride(cwd, DEFAULT_CONFIG), {
      path: '"中🙂'.repeat(MAX_BLOCK_BYTES),
      limit: 0,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(error instanceof Error && Buffer.byteLength(error.message) <= MAX_BLOCK_BYTES);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "limit");
      assert.equal(result.argumentsOmitted, true);
      assert.equal(result.omittedIssues, undefined);
      return true;
    },
  );
});

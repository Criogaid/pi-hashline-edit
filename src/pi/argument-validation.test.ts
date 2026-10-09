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
import { argumentError, rejectsArgument } from "./argument-error.testing.ts";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";

const invalidCommand = { command: "", timeout: 0 };
const anchorHash = "A".repeat(DEFAULT_CONFIG.hashLen);
const cases = [
  {
    name: "read",
    make: (cwd: string, _fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeReadOverride(cwd, DEFAULT_CONFIG),
    args: { offset: -1, limit: 0 },
    fields: ["offset", "limit"],
  },
  {
    name: "grep",
    make: (cwd: string, _fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeGrepOverride(cwd, DEFAULT_CONFIG),
    args: { pattern: [], literal: true, limit: 0, context: -1 },
    fields: ["pattern", "limit", "context"],
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
    fields: [
      "edits[0].body",
      "edits[1].body[0]",
      "edits[1].body[1]",
      "edits[2].anchor",
      "edits[2].end",
      "edits[3].body",
      "then_run.command",
      "then_run.timeout",
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
    fields: [
      "replacements[0].replace",
      "replacements[0].find",
      "replacements[1].replace",
      "replacements[1].find",
      "then_run.command",
      "then_run.timeout",
    ],
  },
  {
    name: "write",
    make: (cwd: string, fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeWriteOverride(cwd, fusion),
    args: { content: "bad\0", mode: "invalid", then_run: invalidCommand },
    fields: ["content", "mode", "then_run.command", "then_run.timeout"],
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
    const args: unknown = JSON.parse(JSON.stringify({ path, ...scenario.args, unexpected: true }));
    await assert.rejects(callTool(tool, args), (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set([...scenario.fields, "unexpected"]),
      );
      assert.deepEqual(result.arguments, args);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(commandRuns, 0);
  });
}

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
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, "edits[0].body");
        assert.match(result.issues[0].reason, /empty/);
        assert.match(
          result.issues[0].reason,
          op === "replace" ? /delete/ : /supply at least one line/,
        );
        assert.equal(result.schemaLimited, undefined);
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
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set([
          "edits[0].body",
          "edits[0].anchor",
          "edits[0].extra",
          "edits[1].body",
          "edits[2].anchor",
          "then_run.command",
          "then_run.timeout",
          "unexpected",
        ]),
      );
      return true;
    },
  );
});

test("edit operation tag is missing or invalid → report its field once without guessing a branch", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const tag of [undefined, "unknown", null, 42, {}]) {
    await assert.rejects(
      callTool(tool, {
        path: "unused.txt",
        edits: [
          { ...(tag === undefined ? {} : { op: tag }), anchor: `1#${anchorHash}`, body: ["valid"] },
        ],
      }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, "edits[0].op");
        if (tag === undefined) assert.match(result.issues[0].reason, /required/);
        else
          for (const op of [
            "replace",
            "delete",
            "insert_before",
            "insert_after",
            "append",
            "prepend",
          ])
            assert.ok(result.issues[0].reason.includes(op));
        return true;
      },
    );
  }
});

test("edit range end is null → preserve the original rejection and its field diagnostic", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const operation of [
    { op: "delete", anchor: `1#${anchorHash}`, end: null },
    { op: "replace", anchor: `1#${anchorHash}`, end: null, body: ["ok"] },
    { op: "replace", anchor: `1#${anchorHash}`, end: null, body: [] },
  ]) {
    await assert.rejects(
      callTool(tool, { path: "unused.txt", edits: [operation] }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.deepEqual(
          result.issues.map((issue) => issue.field),
          operation.body?.length === 0 ? ["edits[0].body", "edits[0].end"] : ["edits[0].end"],
        );
        return true;
      },
    );
  }
});

test("edit item is not an object → report the item type once", async () => {
  for (const item of [null, 42, "bad", [], true]) {
    await assert.rejects(
      callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), {
        path: "unused.txt",
        edits: [item],
      }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        return rejectsArgument("edits[0]", /object/)(error);
      },
    );
  }
});

test("grep union value has one applicable type → report only its constraint", async () => {
  for (const pattern of ["", [], [""]]) {
    await assert.rejects(
      callTool(makeGrepOverride(process.cwd(), DEFAULT_CONFIG), { pattern, literal: true }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.match(result.issues[0].field, /^pattern(?:\[0\])?$/);
        assert.doesNotMatch(result.issues[0].reason, /anyOf/);
        return true;
      },
    );
  }
});

test("literal enum is invalid → report the permitted values once", async () => {
  await assert.rejects(
    callTool(makeWriteOverride(process.cwd()), { path: "unused.txt", content: "ok", mode: "bad" }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 1);
      return rejectsArgument("mode", /create.*overwrite/)(error);
    },
  );
});

test("specific child errors exist → omit parent summaries and retain independent fields", async () => {
  await assert.rejects(
    callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG, createActionFusionExecutor()), {
      path: "unused.txt",
      edits: [{ op: "insert_after", body: ["ok"], extra: true }, { op: "unknown" }],
      then_run: { command: "echo ok", extra: true },
      unexpected: true,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set([
          "edits[0].anchor",
          "edits[0].extra",
          "edits[1].op",
          "then_run.extra",
          "unexpected",
        ]),
      );
      return true;
    },
  );
});

test("operation shape does not permit a field → omit inapplicable semantic advice", async () => {
  for (const edits of [
    [{ op: "unknown", anchor: "1#A", body: [] }],
    [{ op: "delete", anchor: `1#${anchorHash}`, body: [] }],
    "bad",
  ]) {
    await assert.rejects(
      callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), { path: "unused.txt", edits }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.doesNotMatch(result.issues[0].reason, /empty|hash length mismatch/);
        return true;
      },
    );
  }
});

test("Pi coerces valid fields while another field fails → do not diagnose the original value", async () => {
  await assert.rejects(
    callTool(makeReadOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "unused.txt",
      offset: "1",
      limit: 0,
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        result.issues.map((issue) => issue.field),
        ["limit"],
      );
      assert.equal(result.schemaLimited, undefined);
      return true;
    },
  );
});

test("multiple required fields are missing → report every missing field", async () => {
  await assert.rejects(
    callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "unused.txt",
      edits: [{ op: "replace" }],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set(["edits[0].anchor", "edits[0].body"]),
      );
      assert.ok(result.issues.every((issue) => /required/.test(issue.reason)));
      assert.equal(result.schemaLimited, undefined);
      return true;
    },
  );
});

test("unknown field names contain punctuation, numeric keys or newlines → quote property keys without treating them as array indices", async () => {
  for (const key of ["odd.\nfield/~", "0", "01", "a/b", "a~b", 'quote"field']) {
    await assert.rejects(
      callTool(makeReadOverride(process.cwd(), DEFAULT_CONFIG), {
        path: "unused.txt",
        [key]: true,
      }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, `[${JSON.stringify(key)}]`);
        return true;
      },
    );
  }
});

test("one field exhausts native diagnostics → label the limit and retain another field", async () => {
  await assert.rejects(
    callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "",
      edits: Array.from({ length: 30 }, () => ({ op: "unknown" })),
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(result.issues.some((issue) => issue.field === "path"));
      assert.ok(result.issues.some((issue) => issue.field === "edits[0].op"));
      assert.equal(result.schemaLimited, true);
      return true;
    },
  );
});

test("one field violates independent constraints → combine its reasons without losing either", async () => {
  await assert.rejects(
    callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "unused.txt",
      edits: [{ op: "delete", anchor: `${Number.MAX_SAFE_INTEGER + 1}#A` }],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 1);
      return rejectsArgument("edits[0].anchor", /safe integer[\s\S]*hash length mismatch/)(error);
    },
  );
  await assert.rejects(
    callTool(makeReadOverride(process.cwd(), DEFAULT_CONFIG), { path: "unused.txt", offset: 0.5 }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 1);
      assert.match(
        result.issues[0].reason,
        new RegExp(`multiple of ${POSITIVE_SAFE_INTEGER.multipleOf}`),
      );
      assert.match(result.issues[0].reason, new RegExp(`>= ${POSITIVE_SAFE_INTEGER.minimum}`));
      return true;
    },
  );
});

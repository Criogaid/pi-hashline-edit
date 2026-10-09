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
      assert.deepEqual(echoedArgs, [args]);
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
      (error: Error) => {
        const rows = error.message.split("\n").filter((line) => line.startsWith("  - "));
        assert.equal(rows.length, 1, error.message);
        assert.match(rows[0], /- edits\.0\.op:/);
        assert.doesNotMatch(error.message, /schema is false|anyOf|must be equal to constant/);
        if (tag !== undefined) {
          for (const op of [
            "replace",
            "delete",
            "insert_before",
            "insert_after",
            "append",
            "prepend",
          ]) {
            assert.ok(rows[0].includes(op), error.message);
          }
        }
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
      (error: Error) => {
        assert.match(error.message, /- edits\.0\.end:/);
        assert.doesNotMatch(error.message, /- edits\.0\.op:/);
        if (operation.body?.length === 0) {
          assert.match(error.message, /Invalid argument edits\[0\]\.body:/);
        }
        return true;
      },
    );
  }
});

test("edit item is not an object → report the item type once", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const item of [null, 42, "bad", [], true]) {
    await assert.rejects(callTool(tool, { path: "unused.txt", edits: [item] }), (error: Error) => {
      const rows = error.message.split("\n").filter((line) => line.startsWith("  - "));
      assert.equal(rows.length, 1, error.message);
      assert.match(rows[0], /- edits\.0:.*object/);
      assert.doesNotMatch(error.message, /anyOf/);
      return true;
    });
  }
});

test("grep union value has one applicable type → report only its constraint", async () => {
  const tool = makeGrepOverride(process.cwd(), DEFAULT_CONFIG);
  for (const pattern of ["", [], [""]]) {
    await assert.rejects(callTool(tool, { pattern, literal: true }), (error: Error) => {
      const rows = error.message.split("\n").filter((line) => line.startsWith("  - "));
      assert.equal(rows.length, 1, error.message);
      assert.match(rows[0], /- pattern(?:\.0)?:/);
      assert.doesNotMatch(error.message, /anyOf/);
      return true;
    });
  }
});

test("literal enum is invalid → report the permitted values once", async () => {
  const tool = makeWriteOverride(process.cwd());
  await assert.rejects(
    callTool(tool, { path: "unused.txt", content: "ok", mode: "bad" }),
    (error: Error) => {
      const rows = error.message.split("\n").filter((line) => line.startsWith("  - "));
      assert.equal(rows.length, 1, error.message);
      assert.match(rows[0], /- mode:/);
      assert.ok(rows[0].includes("create") && rows[0].includes("overwrite"), error.message);
      assert.doesNotMatch(error.message, /anyOf|must be equal to constant/);
      return true;
    },
  );
});

test("specific child errors exist → omit parent summaries and retain independent fields", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG, createActionFusionExecutor());
  await assert.rejects(
    callTool(tool, {
      path: "unused.txt",
      edits: [{ op: "insert_after", body: ["ok"], extra: true }, { op: "unknown" }],
      then_run: { command: "echo ok", extra: true },
      unexpected: true,
    }),
    (error: Error) => {
      for (const field of [
        "edits.0.anchor",
        "edits.0.extra",
        "edits.1.op",
        "then_run.extra",
        "unexpected",
      ]) {
        assert.ok(error.message.includes(`- ${field}:`), error.message);
      }
      assert.doesNotMatch(error.message, /anyOf|must not have additional properties/);
      return true;
    },
  );
});

test("operation shape does not permit a field → omit inapplicable semantic advice", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const edits of [
    [{ op: "unknown", anchor: "1#A", body: [] }],
    [{ op: "delete", anchor: `1#${anchorHash}`, body: [] }],
    "bad",
  ]) {
    await assert.rejects(callTool(tool, { path: "unused.txt", edits }), (error: Error) => {
      assert.doesNotMatch(error.message, /Invalid argument/);
      assert.match(error.message, /- edits(?:\.0(?:\.(?:op|body))?)?:/);
      return true;
    });
  }
});

test("Pi coerces valid fields while another field fails → do not diagnose the original value", async () => {
  const tool = makeReadOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused.txt", offset: "1", limit: 0 }),
    (error: Error) => {
      assert.match(error.message, /- limit:/);
      assert.doesNotMatch(error.message, /- offset:|additional errors may remain/);
      return true;
    },
  );
});

test("multiple required fields are missing → report every missing field", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused.txt", edits: [{ op: "replace" }] }),
    (error: Error) => {
      assert.match(error.message, /- edits\.0\.anchor:.*required/);
      assert.match(error.message, /- edits\.0\.body:.*required/);
      assert.doesNotMatch(error.message, /additional errors may remain/);
      return true;
    },
  );
});

test("unknown field name contains punctuation or a newline → quote the path on one diagnostic row", async () => {
  const tool = makeReadOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused.txt", ["odd.\nfield/~"]: true }),
    (error: Error) => {
      const rows = error.message.split("\n").filter((line) => line.startsWith("  - "));
      assert.equal(rows.length, 1, error.message);
      assert.ok(rows[0].includes(JSON.stringify("odd.\nfield/~")), error.message);
      return true;
    },
  );
});

test("one field exhausts native diagnostics → label the limit and retain another field", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, {
      path: "",
      edits: Array.from({ length: 30 }, () => ({ op: "unknown" })),
    }),
    (error: Error) => {
      assert.match(error.message, /- path:/);
      assert.match(error.message, /- edits\.0\.op:/);
      assert.match(error.message, /additional errors may remain/);
      return true;
    },
  );
});

test("one field violates independent constraints → combine its reasons without losing either", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const read = makeReadOverride(process.cwd(), DEFAULT_CONFIG);
  const badAnchor = `${Number.MAX_SAFE_INTEGER + 1}#A`;
  await assert.rejects(
    callTool(edit, { path: "unused.txt", edits: [{ op: "delete", anchor: badAnchor }] }),
    (error: Error) => {
      const rows = error.message
        .split("\n")
        .filter((line) => line.startsWith("Invalid argument edits[0].anchor:"));
      assert.equal(rows.length, 1, error.message);
      assert.match(rows[0], /safe integer/);
      assert.match(rows[0], /hash length mismatch/);
      return true;
    },
  );
  await assert.rejects(callTool(read, { path: "unused.txt", offset: 0.5 }), (error: Error) => {
    const rows = error.message.split("\n").filter((line) => line.startsWith("  - offset:"));
    assert.equal(rows.length, 1, error.message);
    assert.match(rows[0], new RegExp(`multiple of ${POSITIVE_SAFE_INTEGER.multipleOf}`));
    assert.match(rows[0], new RegExp(`>= ${POSITIVE_SAFE_INTEGER.minimum}`));
    return true;
  });
});

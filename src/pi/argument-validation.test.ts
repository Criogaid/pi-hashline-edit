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
import { reportOf } from "./report.ts";

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
      return { status: "succeeded", result: { content: [{ type: "text", text: "ran" }] } };
    });
    const tool = scenario.make(cwd, fusion);
    const args: unknown = JSON.parse(JSON.stringify({ path, ...scenario.args, unexpected: true }));
    await assert.rejects(callTool(tool, args), (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set([...scenario.fields, "unexpected"]),
      );
      return true;
    });
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(commandRuns, 0);
  });
}

test("grep and replace flags → accept V8 modes and reject invalid flags before patterns or file reads", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-flags-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "missing.txt");
  const tools = [
    {
      tool: makeGrepOverride(cwd, DEFAULT_CONFIG),
      args: (find: string, literal: boolean, flags: string) => ({ pattern: find, literal, flags }),
      field: "flags",
    },
    {
      tool: makeReplaceTool(cwd, DEFAULT_CONFIG),
      args: (find: string, literal: boolean, flags: string) => ({
        replacements: [
          { find: "valid", replace: "first" },
          { find, replace: "second", regex: !literal, flags },
        ],
      }),
      field: "replacements[1].flags",
    },
  ];
  for (const { tool, args, field } of tools) {
    for (const literal of [false, true]) {
      for (const flags of ["v", "uv", "x"]) {
        await t.test(`${tool.name}/${literal ? "literal" : "regex"}/${flags}`, async () => {
          const input = { path, ...args(flags === "v" ? "a" : "(", literal, flags) };
          if (flags === "v") {
            const result = await callTool(tool, input);
            assert.equal(reportOf(result)?.error, "PATH_NOT_FOUND");
          } else {
            await assert.rejects(callTool(tool, input), (error: unknown) => {
              const report = argumentError(error);
              assert.equal(report.issues.length, 1);
              assert.equal(report.issues[0].field, field);
              assert.match(report.issues[0].reason, /Invalid flags supplied to RegExp constructor/);
              return true;
            });
          }
        });
      }
    }
  }
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
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, "edits[0].body");
        assert.match(result.issues[0].reason, /empty/);
        assert.match(
          result.issues[0].fix ?? "",
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
      return rejectsArgument("edits[0].anchor", /safe integer[\s\S]*hash characters/)(error);
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

test("copy/move destination tokens → reject unsafe positions and wrong hash lengths before reading", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const op of ["copy", "move"]) {
    for (const side of ["before", "after"]) {
      for (const [token, reason] of [
        [`${Number.MAX_SAFE_INTEGER + 1}#${anchorHash}`, /safe integer/],
        ["1#A", /has 1 hash characters/],
      ] as const) {
        await assert.rejects(
          callTool(tool, {
            path: "missing-copy-move.txt",
            edits: [{ op, anchor: `1#${anchorHash}`, [side]: token }],
          }),
          rejectsArgument(`edits[0].${side}`, reason),
        );
      }
    }
  }
});

test("copy/move illegal argument shapes → reject before any file access", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const anchor = `1#${anchorHash}`;
  for (const op of ["copy", "move"]) {
    for (const fields of [
      {},
      { before: anchor, after: anchor },
      { before: anchor, body: ["unused"] },
      { after: anchor, end: null },
      { before: 1 },
      { before: anchor, end: "1#IXXX" },
    ]) {
      await assert.rejects(
        callTool(tool, { path: "missing-copy-move.txt", edits: [{ op, anchor, ...fields }] }),
        (error: unknown) => {
          const result = argumentError(error);
          assert.equal(result.tool, "edit");
          assert(result.issues.length > 0);
          if ("body" in fields)
            assert(result.issues.some((issue) => issue.field === "edits[0].body"));
          if ("end" in fields)
            assert(result.issues.some((issue) => issue.field === "edits[0].end"));
          if (fields.before === 1)
            assert(result.issues.some((issue) => issue.field === "edits[0].before"));
          return true;
        },
      );
    }
  }
});

const exactlyOneDestination = /expected exactly one of: before, after/;

for (const op of ["copy", "move"] as const) {
  test(`${op} without a destination → one exactly-one issue without a description fix`, async () => {
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    await assert.rejects(
      callTool(tool, {
        path: "unused.txt",
        edits: [{ op, anchor: `1#${anchorHash}` }],
      }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, "edits[0]");
        assert.match(result.issues[0].reason, exactlyOneDestination);
        assert.equal(result.issues[0].fix, undefined);
        assert.equal(result.schemaLimited, undefined);
        return true;
      },
    );
  });

  test(`${op} with both destinations → the same single exactly-one issue, no not-allowed pair`, async () => {
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    await assert.rejects(
      callTool(tool, {
        path: "unused.txt",
        edits: [
          { op, anchor: `1#${anchorHash}`, before: `2#${anchorHash}`, after: `3#${anchorHash}` },
        ],
      }),
      (error: unknown) => {
        const result = argumentError(error);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].field, "edits[0]");
        assert.match(result.issues[0].reason, exactlyOneDestination);
        assert.equal(result.schemaLimited, undefined);
        return true;
      },
    );
  });
}

test("mixed copy and move batch → every operation keeps its exactly-one and unknown-field issues", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, {
      path: "unused.txt",
      edits: [
        { op: "copy", anchor: `1#${anchorHash}`, start: { x: 1 }, to: `2#${anchorHash}` },
        { op: "move", anchor: `3#${anchorHash}` },
      ],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.deepEqual(
        new Set(result.issues.map((issue) => issue.field)),
        new Set(["edits[0]", "edits[0].start", "edits[0].to", "edits[1]"]),
      );
      for (const field of ["edits[0]", "edits[1]"])
        assert.match(
          result.issues.find((issue) => issue.field === field)?.reason ?? "",
          exactlyOneDestination,
        );
      for (const field of ["edits[0].start", "edits[0].to"])
        assert.match(
          result.issues.find((issue) => issue.field === field)?.reason ?? "",
          /not allowed/,
        );
      assert.equal(result.schemaLimited, undefined);
      return true;
    },
  );
});

for (const op of ["copy", "move"] as const) {
  test(`${op} with both destinations and a wrong before hash → keeps the hash-length issue beside exactly-one`, async () => {
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    const shortHash = `2#${"A".repeat(DEFAULT_CONFIG.hashLen - 1)}`;
    await assert.rejects(
      callTool(tool, {
        path: "unused.txt",
        edits: [{ op, anchor: `1#${anchorHash}`, before: shortHash, after: `3#${anchorHash}` }],
      }),
      (error: unknown) => {
        const result = argumentError(error);
        const exactly = result.issues.filter((issue) => issue.field === "edits[0]");
        assert.equal(exactly.length, 1);
        assert.match(exactly[0].reason, exactlyOneDestination);
        const hashIssue = result.issues.find((issue) => issue.field === "edits[0].before");
        assert.ok(hashIssue, JSON.stringify(result.issues));
        assert.match(hashIssue.reason, /hash characters/);
        assert.match(hashIssue.fix ?? "", /Read or grep/);
        assert.ok(!result.issues.some((issue) => issue.field === "edits[0].after"));
        return true;
      },
    );
  });
}

for (const op of ["copy", "move"] as const) {
  for (const side of ["before", "after"] as const) {
    test(`${op} with one ${side} destination and an unknown field → only the unknown field is reported`, async () => {
      const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
      await assert.rejects(
        callTool(tool, {
          path: "unused.txt",
          edits: [
            { op, anchor: `1#${anchorHash}`, [side]: `2#${anchorHash}`, to: `3#${anchorHash}` },
          ],
        }),
        (error: unknown) => {
          const result = argumentError(error);
          assert.equal(result.issues.length, 1);
          assert.equal(result.issues[0].field, "edits[0].to");
          assert.match(result.issues[0].reason, /not allowed/);
          assert.equal(result.schemaLimited, undefined);
          return true;
        },
      );
    });
  }
}

/** Tool schema properties, so expected fix text comes from the schema instead of the test. */
interface SchemaNode {
  readonly description?: string;
  readonly const?: unknown;
  readonly anyOf?: readonly SchemaNode[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
}

const schemaProperties = (tool: {
  readonly parameters: unknown;
}): Readonly<Record<string, SchemaNode>> =>
  (tool.parameters as { properties: Readonly<Record<string, SchemaNode>> }).properties;

const inOrder = (fix: string, pieces: readonly string[]): void => {
  let cursor = -1;
  for (const piece of pieces) {
    const at = fix.indexOf(piece);
    assert.ok(at > cursor, `missing or out of order: ${piece} in ${fix}`);
    cursor = at;
  }
};

test("missing required parameter → fix states the parameter's role from its schema description", async () => {
  const grep = makeGrepOverride(process.cwd(), DEFAULT_CONFIG);
  const write = makeWriteOverride(process.cwd());
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const cases = [
    {
      name: "grep literal",
      tool: grep,
      args: { pattern: "text" },
      field: "literal",
      verify: (fix: string) => assert.equal(fix, schemaProperties(grep).literal?.description),
    },
    {
      name: "write mode",
      tool: write,
      args: { path: "unused.txt", content: "text" },
      field: "mode",
      verify: (fix: string) => {
        const [create, overwrite] = schemaProperties(write).mode?.anyOf ?? [];
        assert.ok(create?.description && overwrite?.description);
        inOrder(fix, ['"create"', create.description, '"overwrite"', overwrite.description]);
      },
    },
    {
      name: "edit op",
      tool: edit,
      args: { path: "unused.txt", edits: [{ anchor: `1#${anchorHash}`, body: ["text"] }] },
      field: "edits[0].op",
      verify: (fix: string) => {
        for (const op of [
          "replace",
          "delete",
          "insert_before",
          "insert_after",
          "copy",
          "move",
          "append",
          "prepend",
        ])
          assert.ok(fix.includes(`\"${op}\"`), `${op} missing from ${fix}`);
        assert.equal(fix.split('"copy"').length - 1, 1);
        assert.equal(fix.split('"move"').length - 1, 1);
      },
    },
  ] as const;
  for (const scenario of cases) {
    await assert.rejects(callTool(scenario.tool, scenario.args), (error: unknown) => {
      const result = argumentError(error);
      const issue = result.issues.find((candidate) => candidate.field === scenario.field);
      assert.ok(issue, JSON.stringify(result.issues));
      assert.match(issue.reason, /is required/);
      assert.ok(issue.fix, JSON.stringify(result.issues));
      scenario.verify(issue.fix);
      return true;
    });
  }
});

test("two operations miss the same required field → the shared fix appears once", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused.txt", edits: [{ op: "replace" }, { op: "replace" }] }),
    (error: unknown) => {
      const result = argumentError(error);
      const anchors = result.issues.filter((issue) => issue.field.endsWith(".anchor"));
      assert.equal(anchors.length, 2);
      assert.equal(anchors.filter((issue) => issue.fix).length, 1);
      const fixes = result.issues.flatMap((issue) => (issue.fix ? [issue.fix] : []));
      assert.equal(new Set(fixes).size, fixes.length, JSON.stringify(fixes));
      const anchorDescriptions = new Set(
        (schemaProperties(tool).edits?.items?.anyOf ?? []).flatMap((branch) =>
          branch.properties?.anchor ? [branch.properties.anchor.description] : [],
        ),
      );
      assert.equal(anchorDescriptions.size, 1);
      const description = [...anchorDescriptions][0];
      assert.ok(description);
      assert.ok(fixes.includes(description));
      return true;
    },
  );
});

test("invalid enum value → the reason carries no description fix", async () => {
  await assert.rejects(
    callTool(makeGrepOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "unused.txt",
      pattern: "text",
      literal: true,
      outputMode: "unknown",
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "outputMode");
      assert.match(result.issues[0].reason, /expected one of/);
      assert.equal(result.issues[0].fix, undefined);
      return true;
    },
  );
});

const branchWithOp = (tool: { readonly parameters: unknown }, op: string): SchemaNode => {
  const branch = (schemaProperties(tool).edits?.items?.anyOf ?? []).find((candidate) => {
    const opSchema = candidate.properties?.op;
    return [opSchema?.const, ...(opSchema?.anyOf ?? []).map((option) => option.const)].includes(op);
  });
  assert.ok(branch, `no edit branch for op ${op}`);
  return branch;
};

const acceptedFields = (branch: SchemaNode): string =>
  `Accepted fields: ${Object.keys(branch.properties ?? {}).join(", ")}.`;

const opExplanation = (branch: SchemaNode): string => {
  const options = branch.properties?.op?.anyOf ?? [{ const: branch.properties?.op?.const }];
  return `${options.map((option) => JSON.stringify(option.const)).join(" or ")}: ${branch.properties?.op?.description}`;
};

test("extra field is not allowed → fix describes the selected shape from its schema", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const grep = makeGrepOverride(process.cwd(), DEFAULT_CONFIG);
  const append = branchWithOp(edit, "append");
  const move = branchWithOp(edit, "move");
  const cases = [
    {
      name: "tagged branch rejects another branch's field",
      tool: edit,
      args: {
        path: "unused.txt",
        edits: [{ op: "append", anchor: `1#${anchorHash}`, body: ["text"] }],
      },
      field: "edits[0].anchor",
      fix: `${opExplanation(append)} ${acceptedFields(append)}`,
    },
    {
      name: "unknown top-level field",
      tool: grep,
      args: { path: "unused.txt", pattern: "text", literal: true, bogus: 1 },
      field: "bogus",
      fix: acceptedFields({ properties: schemaProperties(grep) }),
    },
    {
      name: "transfer branch selected by before",
      tool: edit,
      args: {
        path: "unused.txt",
        edits: [
          { op: "move", anchor: `1#${anchorHash}`, before: `2#${anchorHash}`, body: ["text"] },
        ],
      },
      field: "edits[0].body",
      fix: `${opExplanation(move)} ${acceptedFields(move)}`,
    },
  ] as const;
  for (const scenario of cases) {
    await assert.rejects(callTool(scenario.tool, scenario.args), (error: unknown) => {
      const result = argumentError(error);
      const issue = result.issues.find((candidate) => candidate.field === scenario.field);
      assert.ok(issue, JSON.stringify(result.issues));
      assert.match(issue.reason, /is not allowed/);
      assert.equal(issue.fix, scenario.fix, JSON.stringify(result.issues));
      return true;
    });
  }
});

test("value mismatches the field pattern → fix states the field description from the schema", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const append = branchWithOp(edit, "append");
  const replace = branchWithOp(edit, "replace");
  const cases = [
    {
      name: "body element with a newline",
      args: { path: "unused.txt", edits: [{ op: "append", body: ["a\nb"] }] },
      field: "edits[0].body[0]",
      fix: append.properties?.body?.description,
    },
    {
      name: "anchor without the line-hash shape",
      args: { path: "unused.txt", edits: [{ op: "replace", anchor: "abc", body: ["text"] }] },
      field: "edits[0].anchor",
      fix: replace.properties?.anchor?.description,
    },
  ] as const;
  for (const scenario of cases) {
    await assert.rejects(callTool(edit, scenario.args), (error: unknown) => {
      const result = argumentError(error);
      const issue = result.issues.find((candidate) => candidate.field === scenario.field);
      assert.ok(issue, JSON.stringify(result.issues));
      assert.match(issue.reason, /^must match pattern/);
      assert.equal(issue.fix, scenario.fix, JSON.stringify(result.issues));
      return true;
    });
  }
});

test("two unknown fields in one object → the shared fix appears once", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(edit, {
      path: "unused.txt",
      edits: [{ op: "append", body: ["text"], zzz: 1, yyy: 2 }],
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 2, JSON.stringify(result.issues));
      assert.ok(result.issues.every((issue) => issue.reason === "is not allowed"));
      assert.ok(result.issues[0].fix, JSON.stringify(result.issues));
      assert.equal(result.issues[1].fix, undefined);
      return true;
    },
  );
});

test("value has the wrong type → the reason carries no fix", async () => {
  await assert.rejects(
    callTool(makeReadOverride(process.cwd(), DEFAULT_CONFIG), { path: "unused.txt", limit: "abc" }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].field, "limit");
      assert.match(result.issues[0].reason, /must be number/);
      assert.equal(result.issues[0].fix, undefined);
      return true;
    },
  );
});

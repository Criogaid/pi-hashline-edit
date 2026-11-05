import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeGrepOverride, makeGrepOverrideWithBackend } from "./grep-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { argumentError, rejectsArgument } from "./argument-error.testing.ts";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { reportOf } from "./report.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { computeLineHash } from "../core/hash.ts";
import { grepCounts } from "./grep-output.testing.ts";

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
        { action: "replace", anchor: `1#${anchorHash}`, body: [] },
        { action: "append", body: ["bad\0", "bad\ud800"] },
        { action: "delete", anchor: `${Number.MAX_SAFE_INTEGER + 1}#${anchorHash}`, end: "1#A" },
        { action: "append", body: [] },
        { action: "replace", anchor: `3#${anchorHash}`, end: `1#${anchorHash}`, body: ["text"] },
        { action: "delete", anchor: `4#${anchorHash}`, end: `2#${anchorHash}` },
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
      "edits[4].end",
      "edits[5].end",
      "then_run.command",
      "then_run.timeout",
    ],
    reasons: [
      { field: "edits[4].end", reason: /line 1 is before anchor line 3/ },
      { field: "edits[5].end", reason: /line 2 is before anchor line 4/ },
    ],
  },
  {
    name: "replace",
    make: (cwd: string, fusion: ReturnType<typeof createActionFusionExecutor>) =>
      makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    args: {
      replacements: [
        { find: "(", replace: "bad\0", literal: false },
        { find: "[", replace: "bad\ud800", literal: false },
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
    const snapshot = structuredClone(args);
    const open = t.mock.method(fs, "open");
    syncBuiltinESMExports();
    try {
      await assert.rejects(callTool(tool, args), (error: unknown) => {
        const result = argumentError(error);
        assert.deepEqual(
          new Set(result.issues.map((issue) => issue.field)),
          new Set([...scenario.fields, "unexpected"]),
        );
        if ("reasons" in scenario) {
          for (const expected of scenario.reasons) {
            const issue = result.issues.find((issue) => issue.field === expected.field);
            assert.ok(issue);
            assert.match(issue.reason, expected.reason);
          }
        }
        return true;
      });
      assert.equal(open.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(args, snapshot);
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
          { literal: true, find: "valid", replace: "first" },
          { find, replace: "second", literal, flags },
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
            assert.equal(reportOf(result, tool.name)?.error, "PATH_NOT_FOUND");
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

const editFields = ["anchor", "end", "body"] as const;
type EditField = (typeof editFields)[number];
const fieldValues = {
  anchor: `1#${anchorHash}`,
  end: `2#${anchorHash}`,
  body: ["text"],
};
const actionCases: readonly {
  action: string;
  required: readonly EditField[];
  optional: readonly EditField[];
  expected: string;
}[] = [
  {
    action: "replace",
    required: ["anchor", "body"],
    optional: ["end"],
    expected: "text\nbeta\ngamma\n",
  },
  { action: "delete", required: ["anchor"], optional: ["end"], expected: "beta\ngamma\n" },
  {
    action: "insert_after",
    required: ["anchor", "body"],
    optional: [],
    expected: "alpha\ntext\nbeta\ngamma\n",
  },
  {
    action: "insert_before",
    required: ["anchor", "body"],
    optional: [],
    expected: "text\nalpha\nbeta\ngamma\n",
  },
  { action: "append", required: ["body"], optional: [], expected: "alpha\nbeta\ngamma\ntext\n" },
  { action: "prepend", required: ["body"], optional: [], expected: "text\nalpha\nbeta\ngamma\n" },
];

for (const scenario of actionCases) {
  test(`${scenario.action} field matrix → requires its fields and rejects fields it does not take`, async (t) => {
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    const fields = schemaProperties(tool).edits?.items?.properties;
    const choice = fields?.action?.anyOf?.find((option) => option.const === scenario.action);
    assert.ok(choice?.description);
    const description = choice.description;
    const valid = {
      action: scenario.action,
      ...Object.fromEntries(scenario.required.map((field) => [field, fieldValues[field]])),
    };
    for (const field of scenario.required) {
      for (const value of [undefined, null]) {
        await t.test(
          `${field} is ${value === null ? "null" : "missing"} → reports the required field`,
          async () => {
            const edit: Record<string, unknown> = Object.fromEntries(
              Object.entries(valid).filter(([key]) => key !== field),
            );
            if (value === null) edit[field] = null;
            const args = { path: "unused.txt", edits: [edit] };
            await assert.rejects(callTool(tool, args), (error: unknown) => {
              assert.deepEqual(argumentError(error).issues, [
                {
                  field: `edits[0].${field}`,
                  reason: `is required for "${scenario.action}"`,
                  fix: fields?.[field]?.description,
                },
              ]);
              return true;
            });
          },
        );
      }
    }
    for (const field of editFields.filter(
      (field) => !scenario.required.includes(field) && !scenario.optional.includes(field),
    )) {
      await t.test(`${field} is supplied → reports only that forbidden field`, async () => {
        await assert.rejects(
          callTool(tool, {
            path: "unused.txt",
            edits: [{ ...valid, [field]: fieldValues[field] }],
          }),
          (error: unknown) => {
            assert.deepEqual(argumentError(error).issues, [
              {
                field: `edits[0].${field}`,
                reason: "is not allowed",
                fix: `"${scenario.action}": ${description}`,
              },
            ]);
            assert.match(description, /Takes /);
            return true;
          },
        );
      });
    }
  });
}

test("edit action is missing or invalid → reports choices without guessing field permissions", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const choices = schemaProperties(tool).edits?.items?.properties?.action?.anyOf ?? [];
  assert.deepEqual(
    choices.map((choice) => choice.const),
    actionCases.map(({ action }) => action),
  );
  for (const action of [undefined, "unknown", null, 42, {}]) {
    await assert.rejects(
      callTool(tool, {
        path: "unused.txt",
        edits: [
          {
            ...(action === undefined ? {} : { action }),
            anchor: `1#${anchorHash}`,
            body: ["valid"],
          },
        ],
      }),
      (error: unknown) => {
        const { issues } = argumentError(error);
        assert.equal(issues.length, 1);
        const issue = issues[0];
        assert.equal(issue.field, "edits[0].action");
        if (action === undefined) {
          assert.equal(issue.reason, "is required");
          for (const choice of choices) {
            assert.ok(choice.description);
            inOrder(issue.fix ?? "", [JSON.stringify(choice.const), choice.description]);
          }
        } else {
          assert.equal(
            issue.reason,
            `expected one of: ${choices.map((choice) => JSON.stringify(choice.const)).join(", ")}`,
          );
          assert.equal(issue.fix, undefined);
        }
        return true;
      },
    );
  }
});

test("optional edit fields and then_run are null with Fusion → publishes bytes without rewriting caller arguments", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-null-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "target.txt");
  let commandRuns = 0;
  const fusion = createActionFusionExecutor(async () => {
    commandRuns++;
    return { status: "succeeded", result: { content: [{ type: "text", text: "ran" }] } };
  });
  const tool = makeEditOverride(cwd, DEFAULT_CONFIG, fusion);
  for (const scenario of actionCases) {
    await t.test(`${scenario.action} → accepts null optional fields`, async () => {
      await writeFile(path, "alpha\nbeta\ngamma\n");
      const edit = {
        action: scenario.action,
        ...Object.fromEntries(editFields.map((field) => [field, null])),
        ...Object.fromEntries(
          scenario.required.map((field) => [
            field,
            field === "body" ? ["text"] : token(1, "alpha"),
          ]),
        ),
      };
      const args = { path, edits: [edit], then_run: null };
      const snapshot = structuredClone(args);
      const result = await callTool(tool, args);
      assert.equal(result.isError, undefined);
      assert.equal(reportOf(result, "edit")?.publication, "PUBLISHED");
      assert.equal(reportOf(result, "edit")?.then_run, undefined);
      assert.deepEqual(await readFile(path), Buffer.from(scenario.expected));
      assert.deepEqual(args, snapshot);
    });
  }
  assert.equal(commandRuns, 0);
});

test("null optional fields → grep applies defaults without filename filters", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-grep-null-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "target.txt");
  const config = DEFAULT_CONFIG;
  await writeFile(path, "x\n".repeat(config.grep.defaultLimit + 1));
  const rgCalls: (readonly string[])[] = [];
  const discover = async (
    args: readonly string[],
    onPath: (path: string) => boolean | Promise<boolean>,
  ) => {
    rgCalls.push(args);
    await onPath(path);
    return { code: 0, stderr: "", stopped: false };
  };
  const tool = makeGrepOverrideWithBackend(cwd, config, {
    runRgPaths: (args, _signal, onPath) => discover(args, onPath),
    runRgLines: (args, _signal, _maxLines, onFile) =>
      discover(args, (file) => onFile(file, undefined)),
  });
  const result = await callTool(tool, {
    pattern: "x",
    literal: true,
    glob: null,
    limit: null,
    context: null,
  });
  assert.equal(result.isError, undefined);
  assert.equal(grepCounts(result).matches, config.grep.defaultLimit);
  assert.equal(reportOf(result, "grep")?.matchLimit, config.grep.defaultLimit);
  assert.ok(rgCalls.length > 0);
  for (const args of rgCalls) {
    const globs = args.flatMap((arg, index) => (arg === "--glob" ? [args[index + 1]] : []));
    // The built-in .git exclusion remains; null adds no filename filter.
    assert.deepEqual(globs, ["!.git"]);
  }
});

test("edit batch has 64 or 65 operations → publishes the maximum or rejects the oversized batch unchanged", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-edit-limit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "target.txt");
  const tool = makeEditOverride(cwd, DEFAULT_CONFIG);
  const maxEdits: unknown = Reflect.get(tool.parameters.properties.edits, "maxItems");
  assert.ok(typeof maxEdits === "number");
  assert.equal(maxEdits, 64);
  const lines = Array.from({ length: maxEdits + 2 }, (_, i) => `line ${i + 1}`);
  const original = Buffer.from(`${lines.join("\n")}\n`);
  for (const count of [maxEdits, maxEdits + 1]) {
    await t.test(
      `${count} edits → ${count === maxEdits ? "publishes distinct deletions" : `rejects edits above max${maxEdits}`}`,
      async () => {
        await writeFile(path, original);
        const args = {
          path,
          edits: lines
            .slice(0, count)
            .map((line, i) => ({ action: "delete", anchor: token(i + 1, line) })),
        };
        const snapshot = structuredClone(args);
        if (count === maxEdits) {
          const result = await callTool(tool, args);
          assert.equal(result.isError, undefined);
          assert.equal(reportOf(result, "edit")?.publication, "PUBLISHED");
          assert.deepEqual(await readFile(path), Buffer.from(`${lines.slice(count).join("\n")}\n`));
        } else {
          await assert.rejects(callTool(tool, args), (error: unknown) => {
            const report = argumentError(error);
            assert.equal(report.issues.length, 1);
            assert.equal(report.issues[0].field, "edits");
            assert.match(
              report.issues[0].reason,
              new RegExp(`must not have more than ${maxEdits} items`),
            );
            return true;
          });
          assert.deepEqual(await readFile(path), original);
        }
        assert.deepEqual(args, snapshot);
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
      edits: Array.from({ length: 30 }, () => ({ action: "unknown" })),
    }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.ok(result.issues.some((issue) => issue.field === "path"));
      assert.ok(result.issues.some((issue) => issue.field === "edits[0].action"));
      assert.equal(result.schemaLimited, true);
      return true;
    },
  );
});

test("one field violates independent constraints → combine its reasons without losing either", async () => {
  await assert.rejects(
    callTool(makeEditOverride(process.cwd(), DEFAULT_CONFIG), {
      path: "unused.txt",
      edits: [{ action: "delete", anchor: `${Number.MAX_SAFE_INTEGER + 1}#A` }],
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

test("edit fields contain semantic errors → checks only fields accepted by their action", async (t) => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  for (const scenario of actionCases) {
    const valid = {
      action: scenario.action,
      ...Object.fromEntries(scenario.required.map((field) => [field, fieldValues[field]])),
    };
    for (const field of editFields) {
      const accepted = scenario.required.includes(field) || scenario.optional.includes(field);
      const values: readonly (readonly [unknown, RegExp])[] =
        field === "body"
          ? [
              [[], /empty/],
              [["bad\0"], /NUL/],
              [["bad\ud800"], /surrogate|UTF-8/],
            ]
          : [
              [`${Number.MAX_SAFE_INTEGER + 1}#${anchorHash}`, /safe integer/],
              ["1#A", /hash characters/],
            ];
      for (const [value, reason] of values) {
        await t.test(
          `${scenario.action}/${field}/${reason.source} → ${accepted ? "reports value error" : "reports only forbidden field"}`,
          async () => {
            const edit = { ...valid, [field]: value };
            await assert.rejects(
              callTool(tool, { path: "unused.txt", edits: [edit] }),
              (error: unknown) => {
                const report = argumentError(error);
                assert.equal(report.issues.length, 1, JSON.stringify(report));
                const issue = report.issues[0];
                assert.equal(
                  issue.field,
                  `edits[0].${field}${accepted && field === "body" && Array.isArray(value) && value.length ? "[0]" : ""}`,
                );
                if (accepted) {
                  assert.match(issue.reason, reason);
                  if (field === "body" && Array.isArray(value) && value.length === 0) {
                    assert.match(
                      issue.fix ?? "",
                      scenario.action === "replace"
                        ? /"action":"delete"/
                        : /supply at least one line/,
                    );
                  }
                } else {
                  assert.equal(issue.reason, "is not allowed");
                  assert.match(issue.fix ?? "", new RegExp(`^"${scenario.action}":.*Takes `));
                }
                return true;
              },
            );
          },
        );
      }
    }
  }
});

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
  let discoveries = 0;
  const discover = async () => {
    discoveries++;
    return { code: 1, stderr: "", stopped: false };
  };
  const grep = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, {
    runRgPaths: discover,
    runRgLines: discover,
  });
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
  assert.equal(discoveries, 0);
});

test("two operations miss the same required field → the shared fix appears once", async () => {
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  await assert.rejects(
    callTool(tool, { path: "unused.txt", edits: [{ action: "replace" }, { action: "replace" }] }),
    (error: unknown) => {
      const result = argumentError(error);
      const anchors = result.issues.filter((issue) => issue.field.endsWith(".anchor"));
      assert.equal(anchors.length, 2);
      assert.equal(anchors.filter((issue) => issue.fix).length, 1);
      const fixes = result.issues.flatMap((issue) => (issue.fix ? [issue.fix] : []));
      assert.equal(new Set(fixes).size, fixes.length, JSON.stringify(fixes));
      const description = schemaProperties(tool).edits?.items?.properties?.anchor?.description;
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

const acceptedFields = (shape: SchemaNode): string =>
  `Accepted fields: ${Object.keys(shape.properties ?? {}).join(", ")}.`;

test("unknown field is supplied → fix lists only the flat object's accepted fields", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const grep = makeGrepOverride(process.cwd(), DEFAULT_CONFIG);
  for (const scenario of [
    {
      tool: edit,
      args: { path: "unused.txt", edits: [{ action: "append", body: ["text"], op: "append" }] },
      field: "edits[0].op",
      fix: "Accepted fields: action, anchor, end, body.",
    },
    {
      tool: grep,
      args: { pattern: "text", literal: true, bogus: 1 },
      field: "bogus",
      fix: acceptedFields({ properties: schemaProperties(grep) }),
    },
  ]) {
    await assert.rejects(callTool(scenario.tool, scenario.args), (error: unknown) => {
      assert.deepEqual(argumentError(error).issues, [
        { field: scenario.field, reason: "is not allowed", fix: scenario.fix },
      ]);
      return true;
    });
  }
});

test("value mismatches the field pattern → fix states the field description from the schema", async () => {
  const edit = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const fields = schemaProperties(edit).edits?.items?.properties;
  const cases = [
    {
      name: "body element with a newline",
      args: { path: "unused.txt", edits: [{ action: "append", body: ["a\nb"] }] },
      field: "edits[0].body[0]",
      fix: fields?.body?.description,
    },
    {
      name: "anchor without the line-hash shape",
      args: { path: "unused.txt", edits: [{ action: "replace", anchor: "abc", body: ["text"] }] },
      field: "edits[0].anchor",
      fix: fields?.anchor?.description,
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
      edits: [{ action: "append", body: ["text"], zzz: 1, yyy: 2 }],
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

function token(line: number, content: string): string {
  const hashLen = DEFAULT_CONFIG.hashLen;
  return createAnchorFormatter(hashLen).reference(line, computeLineHash(line, content, hashLen));
}

test("20 unknown keys including a slash → bounded issues retain one accepted-fields fix", async () => {
  const tool = makeReadOverride(process.cwd(), DEFAULT_CONFIG);
  const keys = Array.from({ length: 20 }, (_, index) =>
    index === 0 ? "unknown/key" : `unknown${index}`,
  );
  await assert.rejects(
    callTool(tool, { path: "unused.txt", ...Object.fromEntries(keys.map((key) => [key, true])) }),
    (error: unknown) => {
      const result = argumentError(error);
      assert.equal(result.schemaLimited, true);
      assert.ok(result.issues.length >= 8);
      assert.ok(result.issues.some((issue) => issue.field.includes("unknown/key")));
      for (const issue of result.issues) {
        assert.equal(issue.reason, "is not allowed");
      }
      assert.equal(result.issues[0].fix, acceptedFields({ properties: schemaProperties(tool) }));
      assert.ok(result.issues.slice(1).every((issue) => issue.fix === undefined));
      return true;
    },
  );
});

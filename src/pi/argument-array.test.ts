import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentError } from "./argument-error.testing.ts";
import { callTool } from "./tool-call.testing.ts";
import {
  DEFAULT_CONFIG,
  makeEditOverride,
  makeReadOverride,
  makeGrepOverride,
  makeReplaceTool,
} from "./tool-factories.testing.ts";

const cwd = process.cwd();
const edit = makeEditOverride(cwd, DEFAULT_CONFIG);
const replace = makeReplaceTool(cwd, DEFAULT_CONFIG);
const grep = makeGrepOverride(cwd, DEFAULT_CONFIG);
const path = "unused.txt";
const append = { action: "append", lines: ["text"] };
const replacement = { find: "old", replace: "new", literal: true };

const read = makeReadOverride(cwd, DEFAULT_CONFIG);

for (const { tool, args, afterValidation, field } of [
  {
    tool: edit,
    args: { path, steps: [append] },
    afterValidation: { steps: Object.assign([append], { forEach: 0 }) },
    field: "steps.forEach",
  },
  {
    tool: edit,
    args: { path, steps: [append] },
    afterValidation: { steps: [{ ...append, lines: Object.assign(["text"], { join: 0 }) }] },
    field: "steps[0].lines.join",
  },
  {
    tool: replace,
    args: { path, replacements: [replacement] },
    afterValidation: { replacements: Object.assign([replacement], { forEach: 0 }) },
    field: "replacements.forEach",
  },
  {
    tool: grep,
    args: { pattern: ["text"], literal: true },
    afterValidation: {
      path: Object.assign(["."], { "01": 0 }),
      glob: Object.assign(["*"], { flatMap: 0 }),
      pattern: ["("],
      literal: false,
    },
    field: 'path["01"]',
  },
  {
    tool: edit,
    args: { path, steps: [append] },
    afterValidation: { steps: [, { action: "append" }] },
    field: "steps[0]",
  },
  {
    tool: read,
    args: { path },
    afterValidation: { path: Object.assign([path], { flatMap: 0 }) },
    field: "path.flatMap",
  },
]) {
  test(`hook changes ${field} → reports only the first malformed array path`, async () => {
    await assert.rejects(callTool(tool, args, { afterValidation }), (error: unknown) => {
      const report = argumentError(error);
      assert.equal(report.error, "INVALID_ARGUMENTS");
      assert.deepEqual(
        report.issues.map(({ field }) => field),
        [field],
      );
      return true;
    });
  });
}

test("hook replaces steps with a singleton containing a named lines property → reports the steps type error", async () => {
  const steps = { ...append, lines: Object.assign(["text"], { note: 0 }) };
  await assert.rejects(
    callTool(edit, { path, steps: [append] }, { afterValidation: { steps } }),
    (error: unknown) => {
      const report = argumentError(error);
      assert.equal(report.error, "INVALID_ARGUMENTS");
      assert.deepEqual(
        report.issues.map(({ field }) => field),
        ["steps"],
      );
      return true;
    },
  );
});

test("nested call supplies a named array property → rejects it before preparation reads the array", async () => {
  const args = { pattern: ["text"], literal: true, path: Object.assign(["."], { flatMap: 0 }) };
  await assert.rejects(callTool(grep, args), (error: unknown) => {
    const report = argumentError(error);
    assert.equal(report.error, "INVALID_ARGUMENTS");
    assert.deepEqual(
      report.issues.map(({ field }) => field),
      ["path.flatMap"],
    );
    return true;
  });
});

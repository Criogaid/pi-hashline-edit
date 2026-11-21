/** Isolate a FIFO open so a regression cannot stall the parent runner's I/O threads. */
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  makeEditOverride,
  makeReadOverride,
  makeReplaceTool,
} from "../pi/tool-factories.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

const [directory, kind] = process.argv.slice(2);
assert.ok(directory);
if (kind === "read") {
  await expectToolFailure(
    callTool(makeReadOverride(directory, DEFAULT_CONFIG), { path: "pipe" }),
    "NOT_REGULAR_FILE",
  );
} else {
  assert.equal(kind, "mutation");
  const cases = [
    {
      tool: makeEditOverride(directory, DEFAULT_CONFIG),
      args: { steps: [{ action: "append", lines: ["after"] }] },
    },
    {
      tool: makeReplaceTool(directory, DEFAULT_CONFIG),
      args: { replacements: [{ literal: true, find: "before", replace: "after" }] },
    },
  ];
  for (const path of ["pipe", "alias"]) {
    for (const { tool, args } of cases) {
      await expectToolFailure(
        callTool(tool, { path: join(directory, path), ...args }),
        "NOT_REGULAR_FILE",
        (report) => {
          assert.match(report.message ?? "", /not a regular file/);
          assert.equal(report.publication, "NOT_PUBLISHED");
        },
      );
    }
  }
}

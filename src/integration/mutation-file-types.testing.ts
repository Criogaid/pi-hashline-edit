/** Isolate a FIFO open so a regression cannot stall the parent runner's I/O threads. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEditOverride } from "../pi/tool-factories.testing.ts";
import { makeReplaceTool } from "../pi/tool-factories.testing.ts";
import { DEFAULT_CONFIG } from "../pi/tool-factories.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

const directory = process.argv[2];
assert.ok(directory);
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

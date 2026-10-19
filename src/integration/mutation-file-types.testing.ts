/** Isolate a FIFO open so a regression cannot stall the parent runner's I/O threads. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

const directory = process.argv[2];
assert.ok(directory);
const cases = [
  {
    tool: makeEditOverride(directory, DEFAULT_CONFIG),
    args: { edits: [{ op: "append", body: ["after"] }] },
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

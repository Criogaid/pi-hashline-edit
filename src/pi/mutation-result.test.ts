import { commandCompletion, type SessionCommand } from "./action-fusion.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { generateMutationDetails } from "./mutation-result.ts";
import { displayCarriageReturns } from "./anchor-format.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionFusionScheduler } from "./action-fusion.ts";
import { makeWriteOverride } from "./tool-factories.testing.ts";
import { makeReplaceTool } from "./tool-factories.testing.ts";
import type { MutationFacts, SuccessReport } from "./report-schema.ts";
import { callTool, createToolContext } from "./tool-call.testing.ts";
import { reportOf } from "./report.ts";

// Checked by tsc at the report and tool boundaries; these callers must never run.
function invalidMutationResults(
  replacement: Extract<SuccessReport, { tool: "replace" }>,
  result: Awaited<ReturnType<ReturnType<typeof makeReplaceTool>["execute"]>>,
) {
  // @ts-expect-error A replacement transform must supply the actual count before commit.
  const missingMatches: MutationFacts<"replace"> = { tool: "replace" };
  // @ts-expect-error Edit reports cannot carry replacement counts.
  const countedEdit: Extract<SuccessReport, { tool: "edit" }> = { tool: "edit", matches: 1 };
  // @ts-expect-error A replacement report cannot be used as an edit report.
  const edit: Extract<SuccessReport, { tool: "edit" }> = replacement;
  // @ts-expect-error A possibly failed tool result has no guaranteed diff.
  const diff: string = result.details.diff;
}

test("Bash override supplies only display content → scripts get the command status alone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-command-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A diagnostic that resembles Bash metadata is still display text.
  const printed = 'src\\a.ts(1,7): error: expected "x"\nCommand exited with code 2';
  for (const [name, output] of [
    ["printed.txt", printed],
    ["silent.txt", undefined],
  ] as const) {
    const executeTool: SessionCommand = async () =>
      commandCompletion({ content: output ? [{ type: "text", text: output }] : [] }, true);
    const tool = makeWriteOverride(
      dir,
      createActionFusionScheduler(() => {}),
    );
    const result = await callTool(
      tool,
      { path: name, content: "saved\n", mode: "create", then_run: { command: "check" } },
      { ctx: { ...(await createToolContext(dir, t)), executeTool } },
    );
    const blocks = result.content.map((block) => (block.type === "text" ? block.text : ""));
    const stated = { publication: "PUBLISHED", then_run: { status: "failed" } };
    assert.deepEqual(blocks.slice(0, -1), output ? [output] : [], name);
    assert.deepEqual(JSON.parse(blocks.at(-1) ?? ""), stated, name);
    assert.deepEqual(reportOf(result, "write")?.then_run, stated.then_run, name);
    assert.deepEqual(result.structuredContent, stated, name);
    assert.ok(Value.Check(tool.outputSchema, result.structuredContent), name);
  }
});

for (const [name, before, after] of [
  ["LF", "guard\nold\ntail\n", "guard\nnew\ntail\n"],
  ["CRLF", "guard\r\nold\r\ntail\r\n", "guard\r\nnew\r\ntail\r\n"],
  ["mixed", "guard\r\nold\ntail", "guard\r\nnew\ntail"],
  ["standalone CR", "guard\nold\rtail", "guard\nnew\rtail"],
  ["ending conversion", "same\r\n", "same\n"],
  ["empty file", "", "created"],
  ["BOM and literal escapes", "\uFEFFguard\nold\\n\\0", "\uFEFFguard\nnew\\n\\0"],
  ["no-op", "unchanged\n", "unchanged\n"],
] as const) {
  test(`${name} mutation → details contain only the logical-view diff`, () => {
    const details = generateMutationDetails(before, after, []);
    const logical = generateDiffString(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    assert.deepEqual(details, {
      diff: displayCarriageReturns(logical.diff),
    });
  });
}

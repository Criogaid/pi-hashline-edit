import { commandCompletion, type SessionCommand } from "./action-fusion.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { generateMutationDetails } from "./mutation-result.ts";
import { displayCarriageReturns } from "./anchor-format.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteOverride, DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
import { makeReplaceTool } from "./tool-factories.testing.ts";
import type { SuccessReport } from "./report-schema.ts";
import { callTool, createToolContext } from "./tool-call.testing.ts";
import { reportOf } from "./report.ts";

// Checked by tsc at the report and tool boundaries; these callers must never run.
function invalidMutationResults(
  replacement: Extract<SuccessReport, { tool: "replace" }>,
  result: Awaited<ReturnType<ReturnType<typeof makeReplaceTool>["execute"]>>,
) {
  // @ts-expect-error Edit reports cannot carry replacement counts.
  const countedEdit: Extract<SuccessReport, { tool: "edit" }> = { tool: "edit", matches: 1 };
  // @ts-expect-error A replacement report cannot be used as an edit report.
  const edit: Extract<SuccessReport, { tool: "edit" }> = replacement;
  // @ts-expect-error A possibly failed tool result has no guaranteed diff.
  const diff: string = result.details.diff;
}

test("command content includes images → report text joins only text blocks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-command-content-"));
  try {
    const path = join(dir, "file.txt");
    const executeTool: SessionCommand = async () =>
      commandCompletion({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      });
    const fusion = createActionFusionExecutor(() => {});
    const result = await callTool(
      makeWriteOverride(dir, fusion),
      { path, content: "saved\n", mode: "create", then_run: { command: "check" } },
      { ctx: { ...(await createToolContext(dir, t)), executeTool } },
    );
    assert.equal(reportOf(result, "write")?.then_run?.output, "first\nsecond");
    assert.equal(await readFile(path, "utf8"), "saved\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized command diagnostic → bounds model output and retains the original command card", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-command-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = DEFAULT_OUTPUT_BUDGETS;
  const output = `opening\n${"x".repeat(budget.fieldBytes * 2)}\nlast line`;
  const executeTool: SessionCommand = async () =>
    commandCompletion({ content: [{ type: "text", text: output }] }, true);
  let displayedOutput: unknown;
  const fusion = createActionFusionExecutor((progress) => {
    if (progress.command === "failed") displayedOutput = progress.result?.content[0];
  });
  const result = await callTool(
    makeWriteOverride(dir, fusion),
    { path: "file.txt", content: "saved", mode: "create", then_run: { command: "check" } },
    { ctx: { ...(await createToolContext(dir, t)), executeTool } },
  );
  const report = reportOf({ content: result.content }, "write");
  assert.equal(report?.then_run?.status, "failed");
  const shown = report.then_run.output;
  assert.ok(shown && Buffer.byteLength(shown) <= budget.fieldBytes);
  assert.ok(shown.startsWith("opening\n") && shown.endsWith("\nlast line"));
  assert.deepEqual(displayedOutput, { type: "text", text: output });
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
    const details = generateMutationDetails(before, after);
    const logical = generateDiffString(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    assert.deepEqual(details, {
      diff: displayCarriageReturns(logical.diff),
    });
  });
}

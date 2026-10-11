import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyEdits } from "../core/apply.ts";
import { HashlineError } from "../core/errors.ts";
import { computeLineHash } from "../core/hash.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { formatArgumentError } from "./argument-error.ts";
import { outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { describeEditFailure } from "./failure-context.ts";
import { assembleGrepOutput } from "./grep-output.ts";
import { createOutputBudgetProvider } from "./model-budgets.ts";
import { describeFailure, decodeReport, reportOf } from "./report.ts";
import { decodeWorkerReply } from "./replace-worker-contract.ts";
import { restoreWorkerError } from "./regex-worker-contract.ts";
import { workerFailure } from "./report-cause.ts";
import { callTool } from "./tool-call.testing.ts";

const small = outputBudgetsFor(65_536);
const large = outputBudgetsFor(1_048_576);

function wrongHash(text: string): string {
  const hash = computeLineHash(1, text, DEFAULT_CONFIG.hashLen);
  return (hash[0] === "0" ? "1" : "0") + hash.slice(1);
}

test("model budget grows → argument issues remain complete JSON with counted omissions", () => {
  const issues = Array.from({ length: 100 }, (_, index) => ({
    field: `edits[${index}].body`,
    reason: "中文🙂".repeat(100),
    fix: "Supply a line.",
  }));
  const reports = [outputBudgetsFor(1), small, large].map((budget) => {
    const text = formatArgumentError(
      "edit",
      issues,
      { payload: "x".repeat(large.blockBytes) },
      false,
      budget,
    );
    assert.ok(Buffer.byteLength(text) <= budget.blockBytes);
    const report = decodeReport(text);
    assert.ok(report);
    assert.equal((report.issues?.length ?? 0) + (report.omittedIssues ?? 0), issues.length);
    assert.ok(report.argumentsOmitted);
    return report;
  });
  assert.ok((reports[2].issues?.length ?? 0) > (reports[1].issues?.length ?? 0));
});

test("model row allowance grows → anchor failures return complete observations instead of omitted rows", () => {
  const text = "中文🙂".repeat(800);
  const applied = applyEdits(
    text,
    [{ op: "delete", start: { line: 1, hash: wrongHash(text) } }],
    DEFAULT_CONFIG.hashLen,
    0,
  );
  assert.equal(applied.ok, false);
  if (applied.ok) return;
  const snapshot = { currentText: text, anchors: createAnchorFormatter(DEFAULT_CONFIG.hashLen) };
  const reports = [small, large].map((budget) =>
    describeFailure("edit", describeEditFailure(applied.failure, snapshot, false, budget), {
      mutation: true,
      budget,
    }),
  );
  assert.ok(reports[0].failures?.[0].observedOmitted);
  assert.equal(reports[0].failures?.[0].observed, undefined);
  assert.equal(reports[1].failures?.[0].observed, snapshot.anchors.row(1, text));
  assert.equal(reports[1].failures?.[0].observedOmitted, undefined);
  for (const report of reports) {
    assert.equal(report.publication, "NOT_PUBLISHED");
    assert.ok(report.next?.includes("intended target"));
  }
});

test("model budget grows → grep payload and diagnostics use that call's allowances", () => {
  const payload = Array.from({ length: 3_000 }, () => "中文🙂".repeat(3)).join("\n");
  const warning = "opening\n" + "中文🙂".repeat(800) + "\nfinal cause";
  const outputs = [small, large].map((budget) =>
    assembleGrepOutput({
      formatted: {
        blocks: [payload],
        linesTruncated: false,
        invalidUtf8: [],
        matches: 3_000,
        files: 1,
      },
      warnings: [warning],
      outputMode: "content",
      matchLimitReached: false,
      effectiveLimit: 3_000,
      budget,
    }),
  );
  assert.ok(outputs[0].facts.outputLimit);
  assert.equal(outputs[1].payload, payload);
  assert.equal(outputs[1].facts.outputLimit, undefined);
  assert.ok(Buffer.byteLength(outputs[0].facts.diagnostics!) <= small.fieldBytes);
  assert.equal(outputs[1].facts.diagnostics, warning);
  for (const output of outputs) {
    assert.ok(output.facts.diagnostics?.startsWith("opening"));
    assert.ok(output.facts.diagnostics?.endsWith("final cause"));
    assert.ok(!output.facts.diagnostics?.includes("\uFFFD"));
  }
});

test("worker error reaches the tool → text is bounded once using the selected model", () => {
  const text = "中文🙂".repeat(800);
  const reply = decodeWorkerReply(
    workerFailure(new HashlineError("REGEX_WORKER_FAILED", text, { cause: new Error(text) })),
  );
  assert.ok(reply && "error" in reply);
  const error = restoreWorkerError(reply.error);
  const reports = [small, large].map((budget) =>
    describeFailure("replace", error, { mutation: true, budget }),
  );
  assert.ok(Buffer.byteLength(reports[0].message!) <= small.fieldBytes);
  assert.ok(Buffer.byteLength(reports[0].cause!.message) <= small.fieldBytes);
  assert.equal(reports[1].message, text);
  assert.equal(reports[1].cause?.message, text);
});

test("model switches while a mutation waits → failure uses its starting budget snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "queued.txt");
  const text = "中文🙂".repeat(800);
  await writeFile(path, text);
  let model = { provider: "local", id: "small", contextWindow: 65_536 };
  const budgets = createOutputBudgetProvider(() => model);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withFileMutationQueue(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    const running = callTool(makeEditOverride(dir, DEFAULT_CONFIG, undefined, budgets), {
      path,
      edits: [{ op: "delete", anchor: `1#${wrongHash(text)}` }],
    });
    model = { ...model, id: "large", contextWindow: 1_048_576 };
    assert.equal(budgets().readBytes, large.readBytes);
    release.resolve();
    const report = reportOf(await running);
    assert.ok(report?.failures?.[0].observedOmitted);
    assert.equal(report.failures[0].observed, undefined);
    const next = reportOf(
      await callTool(makeEditOverride(dir, DEFAULT_CONFIG, undefined, budgets), {
        path,
        edits: [{ op: "delete", anchor: `1#${wrongHash(text)}` }],
      }),
    );
    assert.equal(
      next?.failures?.[0].observed,
      createAnchorFormatter(DEFAULT_CONFIG.hashLen).row(1, text),
    );
  } finally {
    release.resolve();
    await holding;
  }
});

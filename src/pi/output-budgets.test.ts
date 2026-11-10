import { Worker } from "node:worker_threads";
import { runRegexReplacements } from "./replace-regex.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyEdits } from "../core/apply.ts";
import { HashlineError } from "../core/errors.ts";
import { computeLineHash } from "../core/hash.ts";
import { openTestSession } from "../testing/session.testing.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { formatArgumentError } from "./argument-error.ts";
import { formatByteSize, outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_CONFIG } from "./tool-factories.testing.ts";
import { makeEditOverride } from "./tool-factories.testing.ts";
import { describeEditFailure } from "./failure-context.ts";
import { grepOutput } from "./grep-output.ts";
import { registerModelBudgets } from "./model-budgets.ts";
import { describeMutationFailure } from "./mutation-result.ts";
import { reportOf } from "./report.ts";
import { workerFailure } from "./report-cause.ts";
import { callTool } from "./tool-call.testing.ts";

const small = outputBudgetsFor(65_536);
const large = outputBudgetsFor(1_048_576);

function wrongHash(text: string): string {
  const hash = computeLineHash(1, text, DEFAULT_CONFIG.hashLen);
  return (hash[0] === "0" ? "1" : "0") + hash.slice(1);
}

test("byte budget sizes include fractional KiB → round to one decimal and preserve whole units", () => {
  for (const [bytes, expected] of [
    [outputBudgetsFor(200_000).readBytes, "195.3 KiB"],
    [outputBudgetsFor(200_000).blockBytes, "48.8 KiB"],
    [outputBudgetsFor(200_000).fieldBytes, "12.2 KiB"],
    [16 * 1024, "16 KiB"],
    [50 * 1024, "50 KiB"],
    [256 * 1024, "256 KiB"],
    [64 * 1024 * 1024, "64 MiB"],
    [1024, "1 KiB"],
    [1023 * 1024, "1023 KiB"],
    [1024 * 1024, "1 MiB"],
    [1025 * 1024, "1025 KiB"],
    [4 * 1024 * 1024, "4 MiB"],
  ] as const) {
    assert.equal(formatByteSize(bytes), expected);
  }
});

test("model budget grows → argument issues remain complete JSON with counted omissions", () => {
  const issues = Array.from({ length: 100 }, (_, index) => ({
    field: `steps[${index}].lines`,
    reason: "中文🙂".repeat(100),
    fix: "Supply a line.",
  }));
  const reports = [outputBudgetsFor(1), small, large].map((budget) => {
    const text = formatArgumentError(issues, false, budget);
    assert.ok(Buffer.byteLength(text) <= budget.blockBytes);
    const report = reportOf({ content: [{ type: "text", text }] }, "edit");
    assert.ok(report);
    assert.equal((report.issues?.length ?? 0) + (report.omittedIssues ?? 0), issues.length);
    return report;
  });
  assert.ok((reports[2].issues?.length ?? 0) > (reports[1].issues?.length ?? 0));
});

test("model row allowance grows → anchor failures return complete observations instead of omitted rows", () => {
  const text = "中文🙂".repeat(800);
  const applied = applyEdits(
    text,
    [{ op: "delete", anchor: { line: 1, hash: wrongHash(text) } }],
    DEFAULT_CONFIG.hashLen,
    0,
  );
  assert.equal(applied.ok, false);
  if (applied.ok) return;
  const snapshot = { currentText: text, anchors: createAnchorFormatter(DEFAULT_CONFIG.hashLen) };
  const reports = [small, large].map((budget) => {
    const report = describeMutationFailure(
      "edit",
      describeEditFailure(snapshot.currentText, applied.failures, snapshot.anchors, budget),
      {
        budget,
      },
    );
    assert.equal(report.error, "ANCHOR_MISMATCH");
    return report;
  });
  assert.ok(reports[0].failures?.[0].notShown);
  assert.equal(reports[0].failures?.[0].observed, undefined);
  assert.equal(reports[1].failures?.[0].observed, snapshot.anchors.row(1, text));
  assert.equal(reports[1].failures?.[0].notShown, undefined);
  for (const report of reports) {
    assert.equal(report.publication, "NOT_PUBLISHED");
    assert.ok(report.next?.includes("intended target"));
  }
});

test("model budget grows → grep payload and diagnostics use that call's allowances", async () => {
  const paths = Array.from({ length: 3_000 }, () => "中文🙂".repeat(3));
  const payload = paths.join("\n");
  const warning = "opening\n" + "中文🙂".repeat(800) + "\nfinal cause";
  const outputs = await Promise.all(
    [small, large].map((budget) =>
      grepOutput({
        cwd: process.cwd(),
        anchors: createAnchorFormatter(DEFAULT_CONFIG.hashLen),
        context: 0,
        outputMode: "files",
        search: {
          files: paths.map((path) => ({
            filePath: join(process.cwd(), path),
            rows: [],
            snapshot: { revision: "", validUtf8: true },
          })),
          candidates: "lines",
          scanLimitReached: false,
          matchLimitReached: false,
        },
        warnings: [warning],
        effectiveLimit: 3_000,
        literalPipe: false,
        budget,
      }),
    ),
  );
  assert.equal(outputs[0].facts.outputLimit, formatByteSize(small.grepBytes));
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

test("worker error reaches the tool → text is bounded once using the selected model", async (t) => {
  const text = "中文🙂".repeat(800);
  const reply = workerFailure(
    new HashlineError("REGEX_WORKER_FAILED", text, { cause: new Error(text) }),
  );
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker) {
    queueMicrotask(() => this.emit("message", reply));
  });
  let error: unknown;
  try {
    await runRegexReplacements(
      "source",
      [{ find: "source", replace: "target", literal: false }],
      5_000,
      undefined,
    );
    assert.fail("Worker failure must reject");
  } catch (failure) {
    error = failure;
  }
  const reports = [small, large].map((budget) =>
    describeMutationFailure("replace", error, { budget }),
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
  let budgets: ReturnType<typeof registerModelBudgets> | undefined;
  const { session, model } = await openTestSession(t, {
    cwd: dir,
    tools: [],
    configure(pi) {
      budgets = registerModelBudgets(pi);
    },
  });
  assert.ok(budgets);
  await session.setModel({ ...model, id: "small", contextWindow: 65_536 });
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
      steps: [{ action: "delete", anchor: `1#${wrongHash(text)}` }],
    });
    await session.setModel({ ...model, id: "large", contextWindow: 1_048_576 });
    assert.equal(budgets().readBytes, large.readBytes);
    release.resolve();
    const report = reportOf(await running, "edit");
    assert.ok(report?.failures?.[0].notShown);
    assert.equal(report.failures[0].observed, undefined);
    const next = reportOf(
      await callTool(makeEditOverride(dir, DEFAULT_CONFIG, undefined, budgets), {
        path,
        steps: [{ action: "delete", anchor: `1#${wrongHash(text)}` }],
      }),
      "edit",
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

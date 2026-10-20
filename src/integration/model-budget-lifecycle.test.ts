import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import hashlineEdit from "../index.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { outputBudgetsFor } from "../pi/budgets.ts";
import { decodeReport, reportOf, type Report } from "../pi/report.ts";
import { openTestSession } from "../testing/session.testing.ts";

// Budget invalidation relies on Pi publishing the new model before tool preparation.
test("model selection → exposes the new limit and invalidates only on a selection change", async (t) => {
  const observations: { source: string; id: string | undefined; limit: number | undefined }[] = [];
  const fixture = await openTestSession(t, {
    tools: [],
    configure(pi) {
      pi.on("session_start", (_event, ctx) => {
        observations.push({ source: "start", id: ctx.model?.id, limit: ctx.model?.contextWindow });
      });
      pi.on("model_select", (event, ctx) => {
        assert.equal(ctx.model?.id, event.model.id);
        assert.equal(ctx.model?.contextWindow, event.model.contextWindow);
        observations.push({
          source: event.source,
          id: event.model.id,
          limit: event.model.contextWindow,
        });
      });
    },
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].limit, fixture.model.contextWindow);
  const small = { ...fixture.model, id: "small", contextWindow: 65_536 };
  const large = { ...fixture.model, id: "large", contextWindow: 1_048_576 };
  fixture.session.modelRuntime.registerProvider(fixture.model.provider, {
    api: "openai-completions",
    baseUrl: "https://unused.invalid",
    apiKey: "local-test-placeholder",
    models: [small, large],
  });
  await fixture.session.setModel(small);
  await fixture.session.setModel(small);
  assert.deepEqual(observations.slice(1), [
    { source: "set", id: "small", limit: small.contextWindow },
  ]);
  fixture.session.setScopedModels([{ model: small }, { model: large }]);
  await fixture.session.cycleModel();
  assert.deepEqual(observations.at(-1), {
    source: "cycle",
    id: "large",
    limit: large.contextWindow,
  });
  const ctx = fixture.session.extensionRunner.createToolContext("budget-probe", undefined);
  assert.equal(ctx.model?.contextWindow, large.contextWindow);
  await fixture.session.setModel(small);
  assert.equal(ctx.model?.contextWindow, small.contextWindow);
});

test("model capacity changes → read and grep grow and shrink without re-registering tools", async (t) => {
  const { session, cwd, model } = await openTestSession(t, {
    tools: ["read", "grep"],
    configure: (pi) => hashlineEdit(pi),
  });
  const path = join(cwd, "large-row.txt");
  const text = "中文🙂".repeat(30_000);
  await writeFile(path, text);
  const tool = session.getToolDefinition("read");
  assert.ok(tool);
  const ctx = session.extensionRunner.createToolContext("read-budget", undefined);
  await session.setModel({ ...model, id: "small", contextWindow: 65_536 });
  const small = await callTool(tool, { path }, { ctx });
  const smallReport = reportOf(small, "read");
  assert.ok(smallReport?.lineTooLong);
  await session.setModel({ ...model, id: "large", contextWindow: 1_048_576 });
  const large = await callTool(tool, { path }, { ctx });
  const largeReport = reportOf(large, "read");
  assert.ok(largeReport);
  assert.equal(largeReport.lineTooLong, undefined);
  assert.equal(large.content[0].type, "text");
  assert.ok(large.content[0].text.includes(text));
  await session.setModel({ ...model, id: "small", contextWindow: 65_536 });
  const smallAgain = await callTool(tool, { path }, { ctx });
  assert.deepEqual(reportOf(smallAgain, "read")?.lineTooLong, smallReport.lineTooLong);
  const grep = session.getToolDefinition("grep");
  assert.ok(grep);
  const smallSearch = await callTool(grep, { path, pattern: "中文", literal: true }, { ctx });
  await session.setModel({ ...model, id: "large", contextWindow: 1_048_576 });
  const largeSearch = await callTool(grep, { path, pattern: "中文", literal: true }, { ctx });
  assert.equal(
    reportOf(smallSearch, "grep")?.linePreviewLimit,
    outputBudgetsFor(65_536).grepPreviewUnits,
  );
  assert.equal(
    reportOf(largeSearch, "grep")?.linePreviewLimit,
    outputBudgetsFor(1_048_576).grepPreviewUnits,
  );
  assert.equal(largeSearch.content[0].type, "text");
  assert.equal(smallSearch.content[0].type, "text");
  assert.ok(largeSearch.content[0].text.length > smallSearch.content[0].text.length);
  assert.ok(!largeSearch.content[0].text.includes("\uFFFD"));
});

test("model switches before argument preparation → rejection uses the new budget without execution", async (t) => {
  const { session, model } = await openTestSession(t, {
    tools: ["edit"],
    configure: (pi) => hashlineEdit(pi),
  });
  const tool = session.getToolDefinition("edit");
  const prepare = tool?.prepareArguments;
  assert.ok(prepare);
  const args = {
    path: "never-opened.txt",
    edits: Array.from({ length: 400 }, () => ({ op: "append", body: [] })),
  };
  const reports: Report[] = [];
  for (const [id, contextWindow] of [
    ["small", 65_536],
    ["large", 1_048_576],
  ] as const) {
    await session.setModel({ ...model, id, contextWindow });
    assert.throws(
      () => prepare(args),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const budget = outputBudgetsFor(contextWindow);
        assert.ok(Buffer.byteLength(error.message) <= budget.blockBytes);
        const report = decodeReport(error.message, "edit");
        assert.ok(report?.issues);
        assert.equal(report.issues.length + (report.omittedIssues ?? 0), args.edits.length);
        reports.push(report);
        return true;
      },
    );
  }
  assert.ok(reports[0].omittedIssues);
  assert.equal(reports[1].omittedIssues, undefined);
});

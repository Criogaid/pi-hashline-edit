import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callTool, createToolContext } from "./tool-call.testing.ts";

test("diff generation fails after a mutation → preserves publication and cause", async (t) => {
  const cause = new Error("render failed");
  t.mock.module("./mutation-diff.ts", {
    namedExports: {
      generateRangeDiff() {
        throw cause;
      },
    },
  });
  const { createActionFusionScheduler } = await import("./action-fusion.ts");
  const { DEFAULT_CONFIG, makeReplaceTool } = await import("./tool-factories.testing.ts");
  const { reportOf } = await import("./report.ts");

  const dir = await mkdtemp(join(tmpdir(), "hashline-result-generation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const context = await createToolContext(dir, t);
  const fusion = createActionFusionScheduler(() => {});
  const tool = makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
  const before = "before\n";
  const path = join(dir, "file.txt");
  for (const content of [before, "after\n"]) {
    await writeFile(path, before);
    const executeTool = t.mock.fn(context.executeTool);
    const result = await callTool(
      tool,
      {
        path,
        replacements: [{ literal: true, find: before, replace: content }],
        then_run: { command: "check" },
      },
      { ctx: { ...context, executeTool } },
    );
    const report = reportOf(result, "replace");
    assert.equal(result.isError, true);
    assert.equal(report?.error, "POST_PROCESS_FAILED");
    assert.ok(result.details);
    assert.equal(Reflect.get(result.details, "diff"), undefined);
    assert.equal(report?.publication, content === before ? "NOT_PUBLISHED" : "PUBLISHED");
    assert.deepEqual(report?.cause, { message: cause.message });
    assert.equal(report?.then_run?.status, "skipped");
    assert.equal(executeTool.mock.callCount(), 0);
    assert.equal(await readFile(path, "utf8"), content);
  }
});

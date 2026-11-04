import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionFusionExecutor, type ActionFusionProgress } from "./action-fusion.ts";
import { FileMutationError } from "./file-commit.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { CommandNotRun, describeMutationFailure } from "./mutation-result.ts";
import { renderReport, reportOf } from "./report.ts";
import { callTool, createToolContext } from "./tool-call.testing.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { publishedMutation } from "./mutation-outcome.testing.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hashline-failure-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("temporary preparation and cleanup failures → preserve the commit failure and target bytes", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "unpublished.txt");
    await writeFile(target, "before\n");
    const nativeOpen = fs.open;
    const original = Object.assign(new Error("temporary open failed"), { code: "EIO" });
    let failCleanup = false;
    try {
      t.mock.method(fs, "open", async (...args: Parameters<typeof nativeOpen>) => {
        if (String(args[0]).includes(".hashline-commit-") && args[1] === "w") throw original;
        return nativeOpen(...args);
      });
      const nativeRm = fs.rm;
      t.mock.method(fs, "rm", async (...args: Parameters<typeof nativeRm>) => {
        if (failCleanup && String(args[0]).includes(".hashline-commit-"))
          throw Object.assign(new Error("temporary cleanup failed"), { code: "EACCES" });
        return nativeRm(...args);
      });
      syncBuiltinESMExports();
      for (failCleanup of [false, true]) {
        const result = await callTool(makeWriteOverride(dir), {
          path: target,
          mode: "overwrite",
          content: "after\n",
        });
        const report = reportOf(result, "write");
        assert.equal(result.isError, true);
        assert.equal(report?.error, "PUBLISH_FAILED");
        assert.equal(report.publication, "NOT_PUBLISHED");
        assert.deepEqual(report.cause, { code: original.code, message: original.message });
        assert.equal(await readFile(target, "utf8"), "before\n");
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));

test("published post-processing failure → skips command and preserves publication state", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "published.txt");
    await writeFile(target, "content\n");
    let commanded = false;
    const progress: ActionFusionProgress[] = [];
    const mutationError = new FileMutationError(
      "POST_PROCESS_FAILED",
      "PUBLISHED",
      "result generation failed",
    );
    const fusion = createActionFusionExecutor(
      async () => {
        commanded = true;
        return { status: "succeeded", result: { content: [{ type: "text", text: "never" }] } };
      },
      (update) => progress.push(update),
    );
    await assert.rejects(
      fusion({
        toolCallId: "published",
        absolutePath: target,
        thenRun: { command: "check" },
        mutate: async () => {
          throw mutationError;
        },
        signal: undefined,
        ctx: await createToolContext(dir, t),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommandNotRun);
        assert.equal(error.status, "skipped");
        assert.equal(error.cause, mutationError);
        assert.equal(Object.hasOwn(error, "error"), false);
        const report = describeMutationFailure("edit", error, { budget: DEFAULT_OUTPUT_BUDGETS });
        assert.equal(report.publication, "PUBLISHED");
        assert.equal(report.then_run?.status, "skipped");
        assert.match(report.next ?? "", /change is saved; do not repeat/);
        const diagnostic = renderReport(report);
        assert.equal(diagnostic.split(mutationError.message).length - 1, 1);
        assert.equal(diagnostic.split('"status": "skipped"').length - 1, 1);
        return true;
      },
    );
    assert.equal(commanded, false);
    assert.ok(progress.every((update) => update.mutationCompleted === false));
    assert.equal(await readFile(target, "utf8"), "content\n");
  }));

test("cancellation after publication → does not rerun mutation and still inspects freshness", async (t) =>
  withTemp(async (dir) => {
    for (const state of ["changed", "missing"] as const) {
      const target = join(dir, `${state}.txt`);
      let mutations = 0;
      const controller = new AbortController();
      const fusion = createActionFusionExecutor(async () => {
        if (state === "changed") await writeFile(target, "command changed\n");
        else await rm(target);
        controller.abort();
        throw new Error("timed out");
      });
      const settled = await fusion({
        toolCallId: "cancelled",
        absolutePath: target,
        thenRun: { command: "check" },
        mutate: async () => {
          mutations++;
          await writeFile(target, "mutation\n");
          return publishedMutation("mutation\n", { content: [], details: {} });
        },
        signal: controller.signal,
        ctx: await createToolContext(dir, t),
      });
      assert.equal(settled.outcome.commit.publication, "PUBLISHED");
      assert.equal(settled.command?.status, "cancelled");
      assert.equal(settled.observation.freshness, state);
      assert.equal(mutations, 1);
      if (state === "changed") assert.equal(await readFile(target, "utf8"), "command changed\n");
      else await assert.rejects(readFile(target), { code: "ENOENT" });
    }
  }));

test("first command fails → releases the queue for the next mutation", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "queue.txt");
    const ctx = await createToolContext(dir, t);
    let calls = 0;
    const fusion = createActionFusionExecutor(async () => {
      calls++;
      if (calls === 1) throw new Error("first command failed");
      return { status: "succeeded", result: { content: [{ type: "text", text: "ok" }] } };
    });
    for (const content of ["first\n", "second\n"]) {
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        {
          path: target,
          content,
          mode: calls === 0 ? "create" : "overwrite",
          then_run: { command: "check" },
        },
        { toolCallId: content, ctx },
      );
      assert.equal(
        reportOf(result, "write")?.then_run?.status,
        calls === 1 ? "failed" : "succeeded",
      );
    }
    assert.equal(calls, 2);
    assert.equal(await readFile(target, "utf8"), "second\n");
  }));

test("command succeeds on an unchanged target → retains the result and completed progress", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "finalize.txt");
    const progress: ActionFusionProgress[] = [];
    const fusion = createActionFusionExecutor(
      async () => ({
        status: "succeeded",
        result: { content: [{ type: "text", text: "command finished" }] },
      }),
      (event) => progress.push(event),
    );
    const completed = await callTool(
      makeWriteOverride(dir, fusion),
      { path: target, content: "saved\n", mode: "create", then_run: { command: "check" } },
      { ctx: await createToolContext(dir, t) },
    );
    assert.equal(completed.content.length, 1);
    assert.equal(reportOf(completed, "write")?.then_run?.status, "succeeded");
    assert.equal(reportOf(completed, "write")?.then_run?.output, "command finished");
    assert.equal(progress.filter((event) => event.command === "succeeded").length, 1);
    assert.equal(progress.at(-1)?.freshness, "unchanged");
    assert.deepEqual(progress.at(-1)?.result, {
      content: [{ type: "text", text: "command finished" }],
    });
  }));

test("cancellation before mutation → reports a cancelled command without publishing", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "cancelled.txt");
    await writeFile(target, "before\n");
    const controller = new AbortController();
    controller.abort();
    let commands = 0;
    const progress: ActionFusionProgress[] = [];
    const fusion = createActionFusionExecutor(
      async () => {
        commands++;
        return { status: "succeeded", result: { content: [] } };
      },
      (event) => progress.push(event),
    );
    const result = await callTool(
      makeWriteOverride(dir, fusion),
      { path: target, mode: "overwrite", content: "after\n", then_run: { command: "check" } },
      { signal: controller.signal, ctx: await createToolContext(dir, t) },
    );
    const report = reportOf(result, "write");
    assert.equal(result.isError, true);
    assert.equal(report?.error, "OPERATION_ABORTED");
    assert.equal(report?.publication, "NOT_PUBLISHED");
    assert.equal(report?.then_run?.status, "cancelled");
    assert.deepEqual(
      progress.map((event) => event.command),
      ["waiting", "cancelled"],
    );
    assert.ok(progress.every((event) => !event.mutationCompleted));
    assert.equal(commands, 0);
    assert.equal(await readFile(target, "utf8"), "before\n");
  }));

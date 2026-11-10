import { commandCompletion, type SessionCommand } from "./action-fusion.testing.ts";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionFusionExecutor } from "./action-fusion.ts";
import type { ActionFusionProgress } from "./report-schema.ts";
import { outputBudgetsFor } from "./budgets.ts";
import { reportOf } from "./report.ts";
import { callTool, createToolContext } from "./tool-call.testing.ts";
import { makeWriteOverride } from "./tool-factories.testing.ts";

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

test("publication boundary and observer failures → preserve recovery and emit each diagnostic once", async (t) =>
  withTemp(async (dir) => {
    const budget = outputBudgetsFor(4096);
    const context = await createToolContext(dir, t);
    for (const publication of ["NOT_PUBLISHED", "PUBLISHED", "UNKNOWN"] as const) {
      for (const progressError of [
        undefined,
        "display unavailable",
        Object.assign(new Error("display unavailable " + "界".repeat(budget.fieldBytes)), {
          code: "EIO",
          cause: new Error("nested " + "界".repeat(budget.fieldBytes)),
        }),
      ]) {
        const target = join(dir, "boundary.txt");
        await writeFile(target, "before\n");
        const original = Object.assign(new Error("injected filesystem failure"), { code: "EIO" });
        const nativeOpen = fs.open;
        const nativeRename = fs.rename;
        let published = false;
        let commands = 0;
        const progress: ActionFusionProgress[] = [];
        try {
          t.mock.method(fs, "open", async (...args: Parameters<typeof nativeOpen>) => {
            if (
              publication === "NOT_PUBLISHED" &&
              String(args[0]).includes(".hashline-commit-") &&
              args[1] === "w"
            )
              throw original;
            if (publication === "PUBLISHED" && published && String(args[0]) === target)
              throw original;
            return nativeOpen(...args);
          });
          t.mock.method(fs, "rename", async (...args: Parameters<typeof nativeRename>) => {
            if (String(args[1]) === target && publication === "UNKNOWN") throw original;
            await nativeRename(...args);
            published = true;
          });
          syncBuiltinESMExports();
          const executeTool: SessionCommand = async () => {
            commands++;
            return commandCompletion({ content: [] });
          };
          const fusion = createActionFusionExecutor((update) => {
            progress.push(update);
            if (progressError !== undefined) throw progressError;
          });
          const result = await callTool(
            makeWriteOverride(dir, fusion, () => budget),
            { path: target, mode: "overwrite", content: "after\n", then_run: { command: "check" } },
            { ctx: { ...context, executeTool } },
          );
          const report = reportOf(result, "write");
          assert.equal(result.isError, true);
          assert.ok(report);
          assert.equal(
            report.error,
            publication === "PUBLISHED" ? "POST_PROCESS_FAILED" : "PUBLISH_FAILED",
          );
          assert.equal(report.publication, publication);
          assert.deepEqual(report.cause, { code: original.code, message: original.message });
          assert.equal(report.then_run?.status, "skipped");
          if (publication === "PUBLISHED")
            assert.match(report.next ?? "", /change is saved; do not repeat/);
          else if (publication === "UNKNOWN")
            assert.match(report.next ?? "", /may or may not be saved/);
          else assert.equal(report.next, undefined);
          assert.equal(result.content.length, 1);
          const block = result.content[0];
          assert.equal(block.type, "text");
          const diagnostic = block.text;
          for (const once of [
            original.message,
            report.message,
            '"then_run"',
            '"status": "skipped"',
          ])
            assert.equal(diagnostic.split(once).length - 1, 1);
          assert.equal(commands, 0);
          assert.deepEqual(
            progress.map((update) => update.command),
            ["waiting", "skipped"],
          );
          assert.ok(progress.every((update) => !update.mutationCompleted));
          if (typeof progressError === "string") {
            assert.deepEqual(report.progressError, { message: progressError });
          } else if (progressError) {
            assert.equal(report.progressError?.code, "EIO");
            assert.ok(report.progressError.message.startsWith("display unavailable"));
            assert.ok(Buffer.byteLength(report.progressError.message) <= budget.fieldBytes);
            assert.notEqual(report.progressError.message, progressError.message);
            assert.ok(report.progressError.cause);
            assert.ok(report.progressError.cause.message.startsWith("nested"));
            assert.ok(Buffer.byteLength(report.progressError.cause.message) <= budget.fieldBytes);
            assert.notEqual(report.progressError.cause.message, progressError.cause.message);
          } else assert.equal(report.progressError, undefined);
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
        assert.equal(
          await readFile(target, "utf8"),
          publication === "PUBLISHED" ? "after\n" : "before\n",
        );
      }
    }
  }));

test("cancellation after publication → does not rerun mutation and still inspects freshness", async (t) =>
  withTemp(async (dir) => {
    for (const state of ["changed", "missing"] as const) {
      const target = join(dir, `${state}.txt`);
      const controller = new AbortController();
      const executeTool: SessionCommand = async () => {
        if (state === "changed") await writeFile(target, "command changed\n");
        else await rm(target);
        controller.abort();
        return commandCompletion({ content: [{ type: "text", text: "timed out" }] }, true);
      };
      const fusion = createActionFusionExecutor(() => {});
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        { path: target, mode: "create", content: "mutation\n", then_run: { command: "check" } },
        { signal: controller.signal, ctx: { ...(await createToolContext(dir, t)), executeTool } },
      );
      const report = reportOf(result, "write");
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.then_run?.status, "cancelled");
      assert.equal(report?.freshness, state);
      if (state === "changed") assert.equal(await readFile(target, "utf8"), "command changed\n");
      else await assert.rejects(readFile(target), { code: "ENOENT" });
    }
  }));

test("first command fails → releases the queue for the next mutation", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "queue.txt");
    const ctx = await createToolContext(dir, t);
    let calls = 0;
    const executeTool: SessionCommand = async () => {
      calls++;
      if (calls === 1)
        return commandCompletion(
          { content: [{ type: "text", text: "first command failed" }] },
          true,
        );
      return commandCompletion({ content: [{ type: "text", text: "ok" }] });
    };
    const fusion = createActionFusionExecutor(() => {});
    for (const content of ["first\n", "second\n"]) {
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        {
          path: target,
          content,
          mode: calls === 0 ? "create" : "overwrite",
          then_run: { command: "check" },
        },
        { toolCallId: content, ctx: { ...ctx, executeTool } },
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
    const executeTool: SessionCommand = async () =>
      commandCompletion({ content: [{ type: "text", text: "command finished" }] });
    const fusion = createActionFusionExecutor((event) => progress.push(event));
    const completed = await callTool(
      makeWriteOverride(dir, fusion),
      { path: target, content: "saved\n", mode: "create", then_run: { command: "check" } },
      { ctx: { ...(await createToolContext(dir, t)), executeTool } },
    );
    assert.equal(completed.content.length, 1);
    assert.equal(reportOf(completed, "write")?.then_run?.status, "succeeded");
    assert.equal(reportOf(completed, "write")?.then_run?.output, "command finished");
    assert.equal(progress.filter((event) => event.command === "succeeded").length, 1);
    assert.equal(progress.at(-1)?.freshness, "unchanged");
    assert.deepEqual(progress.at(-1)?.result, {
      content: [{ type: "text", text: "command finished" }],
      details: {},
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
    const executeTool: SessionCommand = async () => {
      commands++;
      return commandCompletion({ content: [] });
    };
    const fusion = createActionFusionExecutor((event) => progress.push(event));
    const result = await callTool(
      makeWriteOverride(dir, fusion),
      { path: target, mode: "overwrite", content: "after\n", then_run: { command: "check" } },
      { signal: controller.signal, ctx: { ...(await createToolContext(dir, t)), executeTool } },
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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionFusionExecutor, type ActionFusionProgress } from "./action-fusion.ts";
import { FileMutationError } from "./file-commit.ts";
import { REREAD } from "./report-schema.ts";
import { CommandNotRun, describeFailure, reportOf } from "./report.ts";
import { createToolContext } from "./tool-call.testing.ts";
import { publishedMutation } from "./mutation-outcome.testing.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hashline-failure-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const mutation = (content: string) => publishedMutation(content, { content: [], details: {} });

test("published post-processing failure → skips command and preserves publication state", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "published.txt");
    await writeFile(target, "content\n");
    let commanded = false;
    const progress: ActionFusionProgress[] = [];
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
        tool: "edit",
        displayPath: "published.txt",
        absolutePath: target,
        thenRun: { command: "check" },
        mutate: async () => {
          throw new FileMutationError(
            "POST_PROCESS_FAILED",
            "post_process",
            "PUBLISHED",
            "result generation failed",
          );
        },
        signal: undefined,
        ctx: await createToolContext(dir, t),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommandNotRun);
        const report = describeFailure("edit", error, { mutation: true });
        assert.equal(report.publication, "PUBLISHED");
        assert.equal(report.then_run?.status, "skipped");
        assert.match(report.next ?? "", /change is saved; do not repeat/);
        return true;
      },
    );
    assert.equal(commanded, false);
    assert.ok(progress.every((update) => update.mutationCompleted === false));
    assert.equal(progress.at(-1)?.publication, "PUBLISHED");
    assert.equal(await readFile(target, "utf8"), "content\n");
  }));

test("command fails and modifies the target → reports changed freshness and command failure", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "failed.txt");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "command changed\n");
      throw new Error("command failed");
    });
    const outcome = await fusion({
      toolCallId: "failed",
      tool: "edit",
      displayPath: "failed.txt",
      absolutePath: target,
      thenRun: { command: "check" },
      mutate: async () => {
        await writeFile(target, "mutation\n");
        return mutation("mutation\n");
      },
      signal: undefined,
      ctx: await createToolContext(dir, t),
    });
    const report = reportOf(outcome, "edit");
    assert.equal(report?.publication, "PUBLISHED");
    assert.equal(report?.then_run?.status, "failed");
    assert.equal(report?.freshness, "changed");
    assert.equal(report?.next, REREAD);
    assert.equal(report?.then_run?.output, "command failed");
    assert.doesNotMatch(
      outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
      /Updated anchors|1#AB/,
    );
    assert.equal(await readFile(target, "utf8"), "command changed\n");
  }));

test("cancellation after publication → does not rerun mutation and still inspects freshness", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "cancelled.txt");
    let mutations = 0;
    const controller = new AbortController();
    const fusion = createActionFusionExecutor(async () => {
      controller.abort();
      throw new Error("timed out");
    });
    const outcome = await fusion({
      toolCallId: "cancelled",
      tool: "edit",
      displayPath: "cancelled.txt",
      absolutePath: target,
      thenRun: { command: "check" },
      mutate: async () => {
        mutations++;
        await writeFile(target, "mutation\n");
        return mutation("mutation\n");
      },
      signal: controller.signal,
      ctx: await createToolContext(dir, t),
    });
    assert.equal(reportOf(outcome, "edit")?.then_run?.status, "cancelled");
    assert.equal(reportOf(outcome, "edit")?.freshness, undefined);
    assert.equal(mutations, 1);
    assert.equal(await readFile(target, "utf8"), "mutation\n");
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
      const result = await fusion({
        toolCallId: content,
        tool: "edit",
        displayPath: "queue.txt",
        absolutePath: target,
        thenRun: { command: "check" },
        mutate: async () => {
          await writeFile(target, content);
          return mutation(content);
        },
        signal: undefined,
        ctx,
      });
      assert.equal(
        reportOf(result, "edit")?.then_run?.status,
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
    const completed = await fusion({
      toolCallId: "finalize",
      tool: "edit",
      displayPath: "finalize.txt",
      absolutePath: target,
      thenRun: { command: "check" },
      signal: undefined,
      ctx: await createToolContext(dir, t),
      mutate: async () => {
        await writeFile(target, "saved\n");
        return mutation("saved\n");
      },
    });
    assert.equal(completed.content.length, 1);
    assert.equal(reportOf(completed, "edit")?.then_run?.status, "succeeded");
    assert.equal(reportOf(completed, "edit")?.then_run?.output, "command finished");
    assert.equal(progress.filter((event) => event.command === "succeeded").length, 1);
    assert.equal(progress.at(-1)?.publication, "PUBLISHED");
    assert.equal(progress.at(-1)?.freshness, "unchanged");
    assert.deepEqual(progress.at(-1)?.result, {
      content: [{ type: "text", text: "command finished" }],
    });
  }));

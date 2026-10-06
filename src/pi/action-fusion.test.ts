import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";
import {
  ACTION_FUSION_GUIDELINES,
  ActionFusionError,
  createActionFusionExecutor,
  THEN_RUN_FAILED,
  THEN_RUN_SKIPPED,
  THEN_RUN_STALE,
  THEN_RUN_SUCCEEDED,
} from "./action-fusion.ts";
import { byteRevision, FileMutationError } from "./file-commit.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { staleTargetNotice } from "./mutation-result.ts";
import { publishedMutation } from "./mutation-outcome.testing.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hashline-action-fusion-"));
}

type Fusion = Parameters<typeof makeWriteOverride>[1];
const mutationFactories = [
  (cwd: string, fusion?: Fusion) => makeEditOverride(cwd, DEFAULT_CONFIG, fusion),
  (cwd: string, fusion?: Fusion) => makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
  makeWriteOverride,
];

test("mutation tools expose Fusion schemas and guidance when supplied an executor", () => {
  const fusion = createActionFusionExecutor();
  for (const makeTool of mutationFactories) {
    const disabled = makeTool("/tmp");
    const enabled = makeTool("/tmp", fusion);
    assert.equal(Object.hasOwn(disabled.parameters.properties, "then_run"), false);
    assert.ok(
      "then_run" in enabled.parameters.properties && enabled.parameters.properties.then_run,
    );
    assert.deepEqual(enabled.promptGuidelines, [
      ...(disabled.promptGuidelines ?? []),
      ...ACTION_FUSION_GUIDELINES,
    ]);
    assert.ok(
      !(disabled.promptGuidelines ?? []).some((line: string) =>
        ACTION_FUSION_GUIDELINES.includes(line),
      ),
    );
  }
});

test("then_run schemas reject invalid commands, unknown keys, and excessive timeouts", async (t) => {
  const dir = await tempDir();
  try {
    for (const makeTool of mutationFactories) {
      const tool = makeTool(dir, createActionFusionExecutor());
      const path = `${tool.name}.txt`;
      await writeFile(join(dir, path), "old\n");
      const mutation =
        tool.name === "edit"
          ? { edits: [{ op: "append", body: ["new"] }] }
          : tool.name === "replace"
            ? { replacements: [{ find: "old", replace: "new" }] }
            : { content: "new\n", mode: "overwrite" };
      for (const then_run of [
        {},
        { command: "   " },
        { command: "echo ok", timeot: 1 },
        { command: "echo ok", timeout: 2_147_483.648 },
      ]) {
        await assert.rejects(
          callTool(tool, { path, ...mutation, then_run }, { ctx: await ctx(dir, t) }),
          new RegExp(`Validation failed for tool "${tool.name}":[\\s\\S]*- then_run`),
        );
        assert.equal(await readFile(join(dir, path), "utf8"), "old\n");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit and replace share one embedded executor and preserve mutation results", async (t) => {
  const dir = await tempDir();
  try {
    const calls: string[] = [];
    const fusion = createActionFusionExecutor(async (_id, input) => {
      calls.push(input.command);
      return "checked";
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    const replace = makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
    await writeFile(join(dir, "edit.txt"), "before\n");
    await writeFile(join(dir, "replace.txt"), "before\n");
    const editResult = await edit.execute(
      "edit-1",
      {
        path: "edit.txt",
        edits: [{ op: "append", body: ["after"] }],
        then_run: { command: "check edit" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const replaceResult = await replace.execute(
      "replace-1",
      {
        path: "replace.txt",
        replacements: [{ find: "before", replace: "after" }],
        then_run: { command: "check replace" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const editOutput = editResult.content.at(-1);
    assert.ok(editOutput?.type === "text");
    assert.match(editOutput.text, new RegExp(THEN_RUN_SUCCEEDED));
    assert.match(
      editResult.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
      /Updated anchors/,
    );
    const replaceOutput = replaceResult.content.at(-1);
    assert.ok(replaceOutput?.type === "text");
    assert.match(replaceOutput.text, new RegExp(THEN_RUN_SUCCEEDED));
    assert.deepEqual(calls, ["check edit", "check replace"]);
    assert.equal(await readFile(join(dir, "edit.txt"), "utf8"), "before\nafter\n");
    assert.equal(await readFile(join(dir, "replace.txt"), "utf8"), "after\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation failure skips the command and command failure does not roll back", async (t) => {
  const dir = await tempDir();
  try {
    let calls = 0;
    const commandFailure = "compiler: unexpected token\nCommand exited with code 7";
    const fusion = createActionFusionExecutor(async () => {
      calls++;
      throw new Error(commandFailure);
    });
    await assert.rejects(
      fusion({
        toolCallId: "x",
        absolutePath: join(dir, "missing.txt"),
        thenRun: { command: "check" },
        mutate: async () => {
          throw new Error("anchor mismatch: current 1#ABCD");
        },
        signal: undefined,
        ctx: await ctx(dir, t),
      }),
      (error: Error) =>
        error.message.includes(THEN_RUN_SKIPPED) &&
        error.message.includes("anchor mismatch: current 1#ABCD"),
    );
    assert.equal(calls, 0);
    const target = join(dir, "changed.txt");
    await writeFile(target, "changed\n");
    const result = await fusion({
      toolCallId: "y",
      absolutePath: target,
      thenRun: { command: "check" },
      mutate: async () =>
        publishedMutation("changed\n", {
          content: [{ type: "text", text: "mutation" }],
          details: { ok: true },
        }),
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    assert.equal(result.content[0].type === "text" && result.content[0].text, "mutation");
    const diagnostic = result.content[1].type === "text" ? result.content[1].text : "";
    assert.ok(diagnostic.includes(THEN_RUN_FAILED) && diagnostic.includes(commandFailure));
    assert.equal(await readFile(target, "utf8"), "changed\n");
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled calls do not mutate or run the command", async (t) => {
  const dir = await tempDir();
  try {
    const controller = new AbortController();
    controller.abort();
    let mutated = false;
    let commanded = false;
    const fusion = createActionFusionExecutor(async () => {
      commanded = true;
      return "";
    });
    await assert.rejects(
      fusion({
        toolCallId: "x",
        absolutePath: join(dir, "cancelled.txt"),
        thenRun: { command: "check" },
        mutate: async () => {
          mutated = true;
          throw new Error("Cancelled mutation must not run");
        },
        signal: controller.signal,
        ctx: await ctx(dir, t),
      }),
    );
    assert.equal(mutated, false);
    assert.equal(commanded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default runner executes a real local command", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "real.txt");
    await writeFile(target, "before\n");
    const fusion = createActionFusionExecutor();
    const result = await fusion({
      toolCallId: "real",
      absolutePath: target,
      thenRun: { command: "node -e \"process.stdout.write('real runner')\"" },
      mutate: async () => {
        await writeFile(target, "after\n");
        return publishedMutation("after\n", {
          content: [{ type: "text", text: "mutated" }],
          details: { ok: true },
        });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.match(output, /real runner/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("marks anchors stale when then_run changes the target", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "stale.txt");
    await writeFile(target, "before\n");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "changed by command\n");
      return "changed";
    });
    const result = await fusion({
      toolCallId: "stale",
      absolutePath: target,
      thenRun: { command: "mutate target" },
      mutate: async () => {
        await writeFile(target, "after mutation\n");
        return publishedMutation(
          "after mutation\n",
          {
            content: [{ type: "text", text: "mutated" }],
            details: undefined,
          },
          " ANCHOR",
        );
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.deepEqual(result.content[1], { type: "text", text: staleTargetNotice(THEN_RUN_STALE) });
    assert.doesNotMatch(output, /ANCHOR/);
    assert.equal((result.details as any)?.actionFusion?.freshness, "changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Action Fusion omits structured anchors when target freshness is unknown", async (t) => {
  const dir = await tempDir();
  try {
    const missing = join(dir, "unreadable.txt");
    let commands = 0;
    const fusion = createActionFusionExecutor(async () => {
      commands++;
      return "unexpected";
    });
    const result = await fusion({
      toolCallId: "unknown",
      absolutePath: missing,
      thenRun: { command: "check" },
      mutate: async () => {
        await writeFile(missing, "mutation\n");
        await rm(missing);
        await mkdir(missing);
        return publishedMutation(
          "mutation\n",
          {
            content: [{ type: "text", text: "mutated" }],
            details: undefined,
          },
          " ANCHOR",
        );
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    const output = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.equal(commands, 0);
    assert.equal((result.details as any).actionFusion.freshness, "unknown");
    assert.doesNotMatch(output, /ANCHOR/);
    assert.deepEqual(result.content[1], { type: "text", text: staleTargetNotice(THEN_RUN_STALE) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit omits Updated anchors when then_run changes the target", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "edit-stale.txt");
    await writeFile(target, "before\n");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "command changed\n");
      return "changed";
    });
    const result = await makeEditOverride(dir, DEFAULT_CONFIG, fusion).execute(
      "edit-stale",
      {
        path: "edit-stale.txt",
        edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "before", 4)}`, body: ["after"] }],
        then_run: { command: "change target" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const output = result.content.map((block: any) => block.text ?? "").join("\n");
    assert.ok(result.details.actionFusion);
    assert.equal(result.details.actionFusion.freshness, "changed");
    assert.deepEqual(result.content[1], { type: "text", text: staleTargetNotice(THEN_RUN_STALE) });
    assert.doesNotMatch(output, /Updated anchors|\b1#[0-9A-Z]+│/);
    assert.equal(await readFile(target, "utf8"), "command changed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all mutation tools forward command progress before completion in RPC mode", async (t) => {
  const dir = await tempDir();
  try {
    const events: ActionFusionProgress[] = [];
    const updates: any[] = [];
    const fusion = createActionFusionExecutor(
      async (_id, _input, _signal, _ctx, onUpdate) => {
        assert.equal(events.at(-1)?.command, "running");
        onUpdate?.({ content: [{ type: "text", text: "live output" }], details: undefined });
        assert.match(updates.at(-1).content.at(-1).text, /live output/);
        assert.equal(events.at(-1)?.output, "live output");
        return "final output";
      },
      (event) => events.push(event),
    );
    const rpcContext = await ctx(dir, t, "rpc");
    const cases = [
      () =>
        makeEditOverride(dir, DEFAULT_CONFIG, fusion).execute(
          "edit",
          {
            path: "progress.txt",
            edits: [{ op: "append", body: ["after"] }],
            then_run: { command: "check" },
          },
          undefined,
          (update) => updates.push(update),
          rpcContext,
        ),
      () =>
        makeReplaceTool(dir, DEFAULT_CONFIG, fusion).execute(
          "replace",
          {
            path: "progress.txt",
            replacements: [{ find: "before", replace: "after" }],
            then_run: { command: "check" },
          },
          undefined,
          (update) => updates.push(update),
          rpcContext,
        ),
      () =>
        makeWriteOverride(dir, fusion).execute(
          "write",
          {
            path: "progress.txt",
            content: "after\n",
            mode: "overwrite",
            then_run: { command: "check" },
          },
          undefined,
          (update) => updates.push(update),
          rpcContext,
        ),
    ];
    for (const run of cases) {
      events.length = 0;
      updates.length = 0;
      await writeFile(join(dir, "progress.txt"), "before\n");
      await run();
      assert.deepEqual(
        events.map((event) => event.command),
        ["waiting", "waiting", "running", "running", "succeeded"],
      );
      assert.deepEqual(
        events.map((event) => event.mutationCompleted),
        [false, true, true, true, true],
      );
      assert.equal(events.at(-1)?.output, "final output");
      assert.equal(events.at(-1)?.publication, "PUBLISHED");
      assert.equal(updates.at(-1).details.actionFusion.command, "succeeded");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress reports skipped mutations and failed commands without rolling back", async (t) => {
  const dir = await tempDir();
  try {
    const events: ActionFusionProgress[] = [];
    let commands = 0;
    const fusion = createActionFusionExecutor(
      async () => {
        commands++;
        throw new Error("diagnostic\nCommand exited with code 7");
      },
      (event) => events.push(event),
    );
    await assert.rejects(
      makeEditOverride(dir, DEFAULT_CONFIG, fusion).execute(
        "skip",
        {
          path: "missing.txt",
          edits: [{ op: "append", body: ["after"] }],
          then_run: { command: "check" },
        },
        undefined,
        undefined,
        await ctx(dir, t),
      ),
    );
    assert.equal(commands, 0);
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "skipped"],
    );
    assert.equal(events.at(-1)!.output, "");
    assert.equal(events.at(-1)!.reason, "Not run because the mutation did not complete.");
    events.length = 0;
    await writeFile(join(dir, "replace.txt"), "original\n");
    await assert.rejects(
      makeReplaceTool(dir, DEFAULT_CONFIG, fusion).execute(
        "replace-skip",
        {
          path: "replace.txt",
          replacements: [{ find: "missing", replace: "changed" }],
          then_run: { command: "check" },
        },
        undefined,
        undefined,
        await ctx(dir, t),
      ),
      /no matches/,
    );
    assert.equal(commands, 0);
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "skipped"],
    );
    assert.equal(await readFile(join(dir, "replace.txt"), "utf8"), "original\n");
    events.length = 0;
    const failed = await makeWriteOverride(dir, fusion).execute(
      "fail",
      {
        path: "failed.txt",
        content: "published\n",
        mode: "create",
        then_run: { command: "check" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.ok(failed.details.actionFusion);
    assert.equal(failed.details.actionFusion.command, "failed");
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "waiting", "running", "failed"],
    );
    assert.equal(events.at(-1)!.output, "diagnostic\nCommand exited with code 7");
    assert.equal(await readFile(join(dir, "failed.txt"), "utf8"), "published\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent mutations on case-differing paths serialize on Windows", {
  skip: process.platform !== "win32",
}, async (t) => {
  const dir = await tempDir();
  try {
    const fusion = createActionFusionExecutor();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p1 = fusion({
      toolCallId: "1",
      absolutePath: join(dir, "caseTest.txt"),
      thenRun: undefined,
      mutate: async () => {
        order.push("start-1");
        await firstRunning;
        order.push("end-1");
        return publishedMutation("first\n", { content: [], details: undefined });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = fusion({
      toolCallId: "2",
      absolutePath: join(dir, "CASETEST.TXT"),
      thenRun: undefined,
      mutate: async () => {
        order.push("start-2");
        order.push("end-2");
        return publishedMutation("second\n", { content: [], details: undefined });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["start-1"]);
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ActionFusionError re-wrapping appends recovery guidance without duplicating outcome banners", async (t) => {
  const dir = await tempDir();
  try {
    const fusion = createActionFusionExecutor();
    const mutationError = new FileMutationError("post_process", "PUBLISHED", "post-process failed");
    let caught: any;
    try {
      await fusion({
        toolCallId: "test-rewrap",
        absolutePath: join(dir, "target.txt"),
        thenRun: { command: "echo done" },
        mutate: async () => {
          throw mutationError;
        },
        signal: undefined,
        ctx: await ctx(dir, t),
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ActionFusionError);
    assert.equal(caught.publication, "PUBLISHED");
    assert.equal(caught.command, "skipped");
    assert.ok(caught.cause instanceof ActionFusionError);
    assert.equal(caught.cause.cause, mutationError);

    const lines = caught.message.split("\n");
    assert.equal(lines[0], "post-process failed");
    assert.ok(lines[1].includes(THEN_RUN_SKIPPED));
    assert.equal(lines[2], "File changes are saved. Command skipped.");
    assert.equal(lines[3], "Re-read before retrying.");
    assert.equal(lines.length, 4);

    // Verify markers appear exactly once
    assert.equal((caught.message.match(/\[then_run:skipped\]/g) ?? []).length, 1);
    assert.equal((caught.message.match(/File changes are saved/g) ?? []).length, 1);
    assert.equal((caught.message.match(/post-process failed/g) ?? []).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fusion uses commit facts when details omit or contradict publication and revision", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "unchanged.txt");
    await writeFile(target, "same\n");
    const commit = {
      publication: "NOT_PUBLISHED" as const,
      publishedRevision: byteRevision("same\n"),
      observedRevision: byteRevision("same\n"),
      created: false,
    };
    for (const details of [
      undefined,
      { publication: "UNKNOWN", publishedRevision: "wrong", observedRevision: "wrong" },
    ]) {
      for (const thenRun of [undefined, { command: "check" }]) {
        let commands = 0;
        const fusion = createActionFusionExecutor(async () => {
          commands++;
          return "checked";
        });
        const result = await fusion({
          toolCallId: "commit-facts",
          absolutePath: target,
          thenRun,
          signal: undefined,
          ctx: await ctx(dir, t),
          mutate: async () => ({
            result: { content: [{ type: "text", text: "mutation" }], details },
            commit,
            anchors: " ANCHOR",
          }),
        });
        assert.deepEqual(result.content[0], { type: "text", text: "mutation ANCHOR" });
        assert.deepEqual(result.details, {
          ...details,
          actionFusion: {
            publication: "NOT_PUBLISHED",
            command: thenRun ? "succeeded" : "not_requested",
            freshness: "unchanged",
          },
        });
        assert.equal(commands, thenRun ? 1 : 0);
        assert.equal(await readFile(target, "utf8"), "same\n");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timed command progress ticks during silence, preserves output, and stops at every outcome", async (t) => {
  for (const outcome of ["succeeded", "failed", "timeout", "cancelled"] as const) {
    await t.test(outcome, async (t) => {
      const dir = await tempDir();
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<string>();
      const controller = new AbortController();
      const events: ActionFusionProgress[] = [];
      const updates: unknown[] = [];
      try {
        const fusion = createActionFusionExecutor(
          async (_id, input, _signal, _ctx, onUpdate) => {
            assert.equal(input.timeout, 10);
            started.resolve();
            onUpdate?.({ content: [{ type: "text", text: "latest output" }], details: undefined });
            return finished.promise;
          },
          (event) => events.push(event),
        );
        const execution = fusion({
          toolCallId: outcome,
          absolutePath: join(dir, "target.txt"),
          thenRun: { command: "check", timeout: 10 },
          mutate: async () => {
            // Mutation time must not consume the command's timeout.
            t.mock.timers.tick(5_000);
            await writeFile(join(dir, "target.txt"), "saved\n");
            return publishedMutation("saved\n", { content: [], details: undefined });
          },
          signal: controller.signal,
          ctx: await ctx(dir, t),
          onUpdate: (update) => updates.push(update),
        });
        await started.promise;
        assert.equal(events[0].timing, undefined);
        assert.deepEqual(events.at(-1)?.timing, { timeoutSeconds: 10, remainingSeconds: 10 });
        const updateCount = updates.length;
        t.mock.timers.tick(2_000);
        assert.equal(updates.length, updateCount + 2);
        assert.equal(events.at(-1)?.timing?.remainingSeconds, 8);
        assert.equal(events.at(-1)?.output, "latest output");
        if (outcome === "succeeded") finished.resolve("complete");
        else {
          if (outcome === "cancelled") controller.abort();
          finished.reject(
            new Error(
              outcome === "timeout" ? "Command timed out" : "command stopped\nunderlying cause",
            ),
          );
        }
        await execution;
        assert.equal(events.at(-1)?.command, outcome);
        const terminalCount = updates.length;
        t.mock.timers.tick(20_000);
        assert.equal(updates.length, terminalCount);
      } finally {
        finished.resolve("");
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("commands without an explicit timeout do not start countdown updates", async (t) => {
  const dir = await tempDir();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<string>();
  const events: ActionFusionProgress[] = [];
  try {
    const fusion = createActionFusionExecutor(
      async (_id, input) => {
        assert.equal(input.timeout, undefined);
        started.resolve();
        return finished.promise;
      },
      (event) => events.push(event),
    );
    const execution = fusion({
      toolCallId: "untimed",
      absolutePath: join(dir, "target.txt"),
      thenRun: { command: "check" },
      mutate: async () => {
        await writeFile(join(dir, "target.txt"), "saved\n");
        return publishedMutation("saved\n", { content: [], details: undefined });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    await started.promise;
    const count = events.length;
    t.mock.timers.tick(20_000);
    assert.equal(events.length, count);
    assert.equal(events.at(-1)?.timing, undefined);
    finished.resolve("complete");
    await execution;
  } finally {
    finished.resolve("");
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi Bash timeout returns the cause to the model while keeping the published file", async (t) => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, "slow.mjs"), "setTimeout(() => {}, 10_000);\n");
    const events: ActionFusionProgress[] = [];
    const fusion = createActionFusionExecutor(undefined, (event) => events.push(event));
    const tool = makeWriteOverride(dir, fusion);
    const result = await callTool(
      tool,
      {
        path: "saved.txt",
        content: "published\n",
        mode: "create",
        then_run: { command: "node slow.mjs", timeout: 0.2 },
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(await readFile(join(dir, "saved.txt"), "utf8"), "published\n");
    assert.equal(result.details.actionFusion.command, "timeout");
    assert.equal(result.details.actionFusion.publication, "PUBLISHED");
    const text = result.content
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("\n");
    assert.match(text, /timed out after 0\.2 seconds/);
    assert.match(text, /File changes.*saved/);
    assert.equal(events.at(-1)?.command, "timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

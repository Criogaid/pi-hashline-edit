import { argumentError, rejectsArguments } from "./argument-error.testing.ts";
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
import type { ActionFusionProgress, CommandOutcome } from "./action-fusion.ts";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor } from "./action-fusion.ts";
import { FileMutationError } from "./file-commit.ts";
import { byteRevision } from "./file-revision.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ACTION_FUSION_PROGRESS_SCHEMA, REREAD } from "./report-schema.ts";
import { Value } from "typebox/value";
import { CommandNotRun, describeFailure, renderReport, reportOf } from "./report.ts";
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
    assert.match(enabled.description, /set the then_run parameter/i);
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
            ? { replacements: [{ literal: true, find: "old", replace: "new" }] }
            : { content: "new\n", mode: "overwrite" };
      for (const then_run of [
        {},
        { command: "   " },
        { command: "echo ok", timeot: 1 },
        { command: "echo ok", timeout: 2_147_483.648 },
      ]) {
        await assert.rejects(
          callTool(tool, { path, ...mutation, then_run }, { ctx: await ctx(dir, t) }),
          (error: unknown) =>
            rejectsArguments()(error) &&
            argumentError(error).issues.some((issue) => issue.field.startsWith("then_run.")),
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
      return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
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
        replacements: [{ literal: true, find: "before", replace: "after" }],
        then_run: { command: "check replace" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    const editOutput = editResult.content.at(-1);
    assert.ok(editOutput?.type === "text");
    assert.equal(reportOf(editResult, "edit")?.then_run?.status, "succeeded");
    assert.equal(editResult.content.length, 1);
    const replaceOutput = replaceResult.content.at(-1);
    assert.ok(replaceOutput?.type === "text");
    assert.equal(reportOf(replaceResult, "replace")?.then_run?.status, "succeeded");
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
        tool: "edit",
        displayPath: join(dir, "missing.txt"),
        absolutePath: join(dir, "missing.txt"),
        thenRun: { command: "check" },
        mutate: async () => {
          throw new Error("anchor mismatch: current 1#ABCD");
        },
        signal: undefined,
        ctx: await ctx(dir, t),
      }),
      (error: unknown) =>
        error instanceof CommandNotRun &&
        error.status === "skipped" &&
        error.message.includes("anchor mismatch: current 1#ABCD"),
    );
    assert.equal(calls, 0);
    const target = join(dir, "changed.txt");
    await writeFile(target, "changed\n");
    const result = await fusion({
      toolCallId: "y",
      tool: "edit",
      displayPath: target,
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
    assert.equal(result.details.ok, true);
    assert.equal(reportOf(result, "edit")?.then_run?.status, "failed");
    assert.equal(reportOf(result, "edit")?.then_run?.output, commandFailure);
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
      return { status: "succeeded", result: { content: [] } };
    });
    await assert.rejects(
      fusion({
        toolCallId: "x",
        tool: "edit",
        displayPath: join(dir, "cancelled.txt"),
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

test("unreadable target after mutation → reports unknown freshness and skips the command", async (t) => {
  const dir = await tempDir();
  try {
    const missing = join(dir, "unreadable.txt");
    let commands = 0;
    const fusion = createActionFusionExecutor(async () => {
      commands++;
      return { status: "succeeded", result: { content: [{ type: "text", text: "unexpected" }] } };
    });
    const result = await fusion({
      toolCallId: "unknown",
      tool: "edit",
      displayPath: missing,
      absolutePath: missing,
      thenRun: { command: "check" },
      mutate: async () => {
        await writeFile(missing, "mutation\n");
        await rm(missing);
        await mkdir(missing);
        return publishedMutation("mutation\n", {
          content: [{ type: "text", text: "mutated" }],
          details: undefined,
        });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    const output = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.equal(commands, 0);
    assert.equal(reportOf(result, "edit")?.freshness, "unknown");
    assert.doesNotMatch(output, /ANCHOR/);
    assert.equal(reportOf(result, "edit")?.next, REREAD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("then_run changes the target → reports changed freshness", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "edit-stale.txt");
    await writeFile(target, "before\n");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "command changed\n");
      return { status: "succeeded", result: { content: [{ type: "text", text: "changed" }] } };
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
    const output = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.equal(reportOf(result, "edit")?.freshness, "changed");
    assert.equal(reportOf(result, "edit")?.next, REREAD);
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
        assert.deepEqual(updates.at(-1).details.actionFusion.result?.content, [
          { type: "text", text: "live output" },
        ]);
        assert.ok(
          updates.every(
            (update) =>
              !update.content.some(
                (block: { type: string; text?: string }) =>
                  block.type === "text" && /Updated anchors|\d+#[0-9A-Z]+/.test(block.text ?? ""),
              ),
          ),
        );
        assert.deepEqual(events.at(-1)?.result?.content, [{ type: "text", text: "live output" }]);
        return {
          status: "succeeded",
          result: { content: [{ type: "text", text: "final output" }] },
        };
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
            replacements: [{ literal: true, find: "before", replace: "after" }],
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
      const result = await run();
      assert.equal(Object.hasOwn(result.details, "actionFusion"), false);
      assert.equal(result.details.report.publication, "PUBLISHED");
      assert.equal(result.details.report.then_run?.status, "succeeded");
      assert.equal(Object.hasOwn(result.details.report, "freshness"), false);
      for (const update of updates)
        assert.equal(Value.Check(ACTION_FUSION_PROGRESS_SCHEMA, update.details.actionFusion), true);
      assert.deepEqual(
        events.map((event) => event.command),
        ["waiting", "waiting", "running", "running", "succeeded"],
      );
      assert.deepEqual(
        events.map((event) => event.mutationCompleted),
        [false, true, true, true, true],
      );
      assert.deepEqual(events.at(-1)?.result?.content, [{ type: "text", text: "final output" }]);
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
    const skipped = await makeEditOverride(dir, DEFAULT_CONFIG, fusion).execute(
      "skip",
      {
        path: "missing.txt",
        edits: [{ op: "append", body: ["after"] }],
        then_run: { command: "check" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.equal(skipped.isError, true);
    assert.equal(reportOf(skipped, "edit")?.then_run?.status, "skipped");
    assert.equal(commands, 0);
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "skipped"],
    );
    assert.equal(events.at(-1)?.result, undefined);
    assert.equal(events.at(-1)!.mutationCompleted, false);
    events.length = 0;
    await writeFile(join(dir, "replace.txt"), "original\n");
    const unmatched = await makeReplaceTool(dir, DEFAULT_CONFIG, fusion).execute(
      "replace-skip",
      {
        path: "replace.txt",
        replacements: [{ literal: true, find: "missing", replace: "changed" }],
        then_run: { command: "check" },
      },
      undefined,
      undefined,
      await ctx(dir, t),
    );
    assert.equal(unmatched.isError, true);
    assert.equal(reportOf(unmatched, "replace")?.error, "NO_MATCH");
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
    assert.equal(reportOf(failed, "write")?.then_run?.status, "failed");
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "waiting", "running", "failed"],
    );
    assert.deepEqual(events.at(-1)?.result, {
      content: [{ type: "text", text: "diagnostic\nCommand exited with code 7" }],
    });
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
    const firstStarted = Promise.withResolvers<void>();
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p1 = fusion({
      toolCallId: "1",
      tool: "edit",
      displayPath: join(dir, "caseTest.txt"),
      absolutePath: join(dir, "caseTest.txt"),
      thenRun: undefined,
      mutate: async () => {
        order.push("start-1");
        firstStarted.resolve();
        await firstRunning;
        order.push("end-1");
        return publishedMutation("first\n", { content: [], details: undefined });
      },
      signal: undefined,
      ctx: await ctx(dir, t),
    });
    await firstStarted.promise;
    const p2 = fusion({
      toolCallId: "2",
      tool: "edit",
      displayPath: join(dir, "CASETEST.TXT"),
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

test("published mutation failure → preserves the original failure and states command and recovery once", async (t) => {
  const dir = await tempDir();
  try {
    const fusion = createActionFusionExecutor();
    const mutationError = new FileMutationError(
      "POST_PROCESS_FAILED",
      "post_process",
      "PUBLISHED",
      "post-process failed",
    );
    let caught: unknown;
    try {
      await fusion({
        toolCallId: "test-rewrap",
        tool: "edit",
        displayPath: join(dir, "target.txt"),
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

    assert.ok(caught instanceof CommandNotRun);
    assert.equal(caught.status, "skipped");
    assert.equal(caught.cause, mutationError);
    assert.equal(Object.hasOwn(caught, "error"), false);
    const report = describeFailure("edit", caught, {});
    assert.equal(report.publication, "PUBLISHED");
    assert.equal(report.stage, "post_process");
    assert.equal(report.then_run?.status, "skipped");
    assert.match(report.next ?? "", /change is saved; do not repeat/);
    const diagnostic = renderReport(report);
    assert.equal(diagnostic.split("post-process failed").length - 1, 1);
    assert.equal(diagnostic.split('"status": "skipped"').length - 1, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fusion takes publication and freshness from commit facts independently of diff details", async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, "unchanged.txt");
    await writeFile(target, "same\n");
    const commit = {
      publication: "NOT_PUBLISHED" as const,
      publishedRevision: byteRevision(Buffer.from("same\n")),
      observedRevision: byteRevision(Buffer.from("same\n")),
      created: false as const,
    };
    for (const details of [{}, { diff: "" }]) {
      for (const thenRun of [undefined, { command: "check" }]) {
        let commands = 0;
        const fusion = createActionFusionExecutor(async () => {
          commands++;
          return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
        });
        const result = await fusion({
          toolCallId: "commit-facts",
          tool: "edit",
          displayPath: target,
          absolutePath: target,
          thenRun,
          signal: undefined,
          ctx: await ctx(dir, t),
          mutate: async () => ({
            details,
            facts: {},
            commit,
          }),
        });
        assert.equal(result.content.length, 1);
        for (const [key, value] of Object.entries(details))
          assert.deepEqual(Reflect.get(result.details, key), value);
        assert.equal(reportOf(result, "edit")?.publication, "NOT_PUBLISHED");
        assert.equal(reportOf(result, "edit")?.freshness, undefined);
        assert.equal(reportOf(result, "edit")?.then_run?.status, thenRun ? "succeeded" : undefined);
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
      const finished = Promise.withResolvers<CommandOutcome>();
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
          tool: "edit",
          displayPath: join(dir, "target.txt"),
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
        assert.deepEqual(events.at(-1)?.result?.content, [{ type: "text", text: "latest output" }]);
        if (outcome === "cancelled") controller.abort();
        finished.resolve({
          status: outcome,
          result: {
            content: [
              {
                type: "text",
                text:
                  outcome === "succeeded"
                    ? "complete"
                    : outcome === "timeout"
                      ? "Command timed out"
                      : "command stopped\nunderlying cause",
              },
            ],
          },
        });
        await execution;
        assert.equal(events.at(-1)?.command, outcome);
        const terminalCount = updates.length;
        t.mock.timers.tick(20_000);
        assert.equal(updates.length, terminalCount);
      } finally {
        finished.resolve({ status: "succeeded", result: { content: [] } });
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("commands without an explicit timeout do not start countdown updates", async (t) => {
  const dir = await tempDir();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<CommandOutcome>();
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
      tool: "edit",
      displayPath: join(dir, "target.txt"),
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
    finished.resolve({
      status: "succeeded",
      result: { content: [{ type: "text", text: "complete" }] },
    });
    await execution;
  } finally {
    finished.resolve({ status: "succeeded", result: { content: [] } });
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fusion fails at a mutation or command boundary → reports each command outcome and cause once", async (t) => {
  const dir = await tempDir();
  try {
    const context = await ctx(dir, t);
    for (const scenario of [
      "not started",
      "failed",
      "prepare",
      "commit",
      "post_process",
      "target changed",
      "revision unreadable",
      "command failed",
      "command timeout",
      "command cancelled",
    ] as const) {
      await t.test(`${scenario} → one phase, status, and cause`, async () => {
        const target = join(dir, `${scenario}.txt`);
        const controller = new AbortController();
        if (scenario === "not started") controller.abort();
        let commands = 0;
        const fusion = createActionFusionExecutor(async () => {
          commands++;
          return {
            status:
              scenario === "command timeout"
                ? "timeout"
                : scenario === "command cancelled"
                  ? "cancelled"
                  : "failed",
            result: { content: [{ type: "text", text: "command diagnostic" }] },
          };
        });
        const stoppedDuringMutation = [
          "not started",
          "failed",
          "prepare",
          "commit",
          "post_process",
        ].includes(scenario);
        const expectedCommand =
          scenario === "not started" || scenario === "command cancelled"
            ? "cancelled"
            : scenario === "command timeout"
              ? "timeout"
              : scenario === "command failed"
                ? "failed"
                : "skipped";
        const invocation = fusion({
          toolCallId: scenario,
          tool: "edit",
          displayPath: target,
          absolutePath: target,
          thenRun: { command: "check" },
          signal: controller.signal,
          ctx: context,
          mutate: async () => {
            if (scenario === "failed") throw new Error("mutation diagnostic");
            if (scenario === "prepare" || scenario === "commit" || scenario === "post_process")
              throw new FileMutationError(
                scenario === "post_process"
                  ? "POST_PROCESS_FAILED"
                  : scenario === "commit"
                    ? "PUBLISH_FAILED"
                    : "FILE_CHANGED",
                scenario,
                scenario === "post_process" ? "PUBLISHED" : "NOT_PUBLISHED",
                "mutation diagnostic",
              );
            await writeFile(target, "published\n");
            const outcome = publishedMutation("published\n", { content: [], details: undefined });
            if (scenario === "target changed") await writeFile(target, "external\n");
            else if (scenario === "revision unreadable") await rm(target);
            return outcome;
          },
        });
        let diagnostic = "";
        if (stoppedDuringMutation) {
          await assert.rejects(invocation, (error: unknown) => {
            assert.ok(error instanceof CommandNotRun);
            const report = describeFailure("edit", error, {});
            diagnostic = renderReport(report);
            assert.equal(report.then_run?.status, expectedCommand);
            return true;
          });
        } else {
          const result = await invocation;
          diagnostic = result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
          assert.equal(result.details.report.publication, "PUBLISHED");
          assert.equal(renderReport(result.details.report), diagnostic);
        }
        const report = JSON.parse(diagnostic);
        assert.equal(report.then_run.status, expectedCommand);
        assert.equal((diagnostic.match(/"then_run"/g) ?? []).length, 1);
        assert.doesNotMatch(
          diagnostic,
          /the command was not run|then_run did not complete successfully/,
        );
        assert.equal(commands, scenario.startsWith("command ") ? 1 : 0);
        if (stoppedDuringMutation && scenario !== "not started")
          assert.equal((diagnostic.match(/mutation diagnostic/g) ?? []).length, 1);
        if (scenario === "target changed") {
          assert.equal(report.freshness, "changed");
          assert.equal(report.next, REREAD);
          assert.equal(await readFile(target, "utf8"), "external\n");
        } else if (scenario === "revision unreadable") {
          assert.equal(report.freshness, "missing");
        } else if (scenario.startsWith("command ")) {
          assert.equal((diagnostic.match(/command diagnostic/g) ?? []).length, 1);
          assert.equal(await readFile(target, "utf8"), "published\n");
        }
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

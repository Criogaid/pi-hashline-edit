import { argumentError, rejectsArguments } from "./argument-error.testing.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import type { ActionFusionProgress } from "./report-schema.ts";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ACTION_FUSION_PROGRESS_SCHEMA, REREAD } from "./report-schema.ts";
import { Value } from "typebox/value";
import { reportOf } from "./report.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { publishedMutation } from "./mutation-outcome.testing.ts";

type ProgressUpdate = AgentToolResult<{ actionFusion?: ActionFusionProgress }>;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hashline-action-fusion-"));
}

type Fusion = Parameters<typeof makeWriteOverride>[1];
type CommandCompletion = Awaited<
  ReturnType<NonNullable<Parameters<typeof createActionFusionExecutor>[0]>>
>;
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
          ? { edits: [{ action: "append", body: ["new"] }] }
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
    const fusion = createActionFusionExecutor(async (input) => {
      calls.push(input.command);
      return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    const replace = makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
    await writeFile(join(dir, "edit.txt"), "before\n");
    await writeFile(join(dir, "replace.txt"), "before\n");
    const editResult = await callTool(
      edit,
      {
        path: "edit.txt",
        edits: [{ action: "append", body: ["after"] }],
        then_run: { command: "check edit" },
      },
      { ctx: await ctx(dir, t) },
    );
    const replaceResult = await callTool(
      replace,
      {
        path: "replace.txt",
        replacements: [{ literal: true, find: "before", replace: "after" }],
        then_run: { command: "check replace" },
      },
      { ctx: await ctx(dir, t) },
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

test("then_run returns a termination flag → parent results preserve its value and omit an absent flag", async (t) => {
  const dir = await tempDir();
  try {
    const context = await ctx(dir, t);
    for (const terminate of [true, false, undefined]) {
      const fusion = createActionFusionExecutor(async () => ({
        status: "succeeded",
        result: { content: [{ type: "text", text: "checked" }] },
        ...(terminate === undefined ? {} : { terminate }),
      }));
      for (const makeTool of mutationFactories) {
        const tool = makeTool(dir, fusion);
        const path = `${tool.name}.txt`;
        await writeFile(join(dir, path), "before\n");
        const mutation =
          tool.name === "edit"
            ? { edits: [{ action: "append", body: ["after"] }] }
            : tool.name === "replace"
              ? { replacements: [{ literal: true, find: "before", replace: "after" }] }
              : { content: "after\n", mode: "overwrite" };
        const result = await callTool(
          tool,
          { path, ...mutation, then_run: { command: "check" } },
          { ctx: context },
        );
        assert.equal(result.terminate, terminate);
        assert.equal(Object.hasOwn(result, "terminate"), terminate !== undefined);
        assert.equal(reportOf(result, tool.name)?.then_run?.status, "succeeded");
        assert.equal(reportOf(result, tool.name)?.then_run?.output, "checked");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("target changes after publication → skips then_run and reports freshness without retry advice", async (t) => {
  const dir = await tempDir();
  try {
    const context = await ctx(dir, t);
    for (const state of ["changed", "missing", "unknown"] as const) {
      const target = join(dir, `${state}.txt`);
      await writeFile(target, "before\n");
      let commands = 0;
      let disturbed = false;
      const fusion = createActionFusionExecutor(
        async () => {
          commands++;
          return { status: "succeeded", result: { content: [] } };
        },
        (progress) => {
          if (!progress.mutationCompleted || disturbed) return;
          disturbed = true;
          if (state === "changed") writeFileSync(target, "external\n");
          else {
            rmSync(target);
            if (state === "unknown") mkdirSync(target);
          }
        },
      );
      const result = await callTool(
        makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        {
          path: target,
          edits: [{ action: "append", body: ["mutation"] }],
          then_run: { command: "check" },
        },
        { ctx: context },
      );
      const report = reportOf(result, "edit");
      assert.equal(disturbed, true);
      assert.equal(commands, 0);
      assert.doesNotMatch(JSON.stringify(result.content), /Updated anchors|\d+#[0-9A-Z]+│/);
      assert.equal(result.isError, undefined);
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.freshness, state);
      assert.equal(report?.then_run?.status, "skipped");
      assert.equal(report?.next, state === "missing" ? undefined : REREAD);
      assert.equal(result.content.length, 1);
      if (state === "unknown") assert.ok(report?.freshnessError);
      if (state === "changed") assert.equal(await readFile(target, "utf8"), "external\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all mutation tools forward command progress before completion in RPC mode", async (t) => {
  const dir = await tempDir();
  try {
    const events: ActionFusionProgress[] = [];
    const updates: ProgressUpdate[] = [];
    const fusion = createActionFusionExecutor(
      async (_input, _signal, _ctx, onUpdate) => {
        assert.equal(events.at(-1)?.command, "running");
        onUpdate?.({ content: [{ type: "text", text: "live output" }], details: undefined });
        assert.deepEqual(updates.at(-1)?.details.actionFusion?.result?.content, [
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
        callTool(
          makeEditOverride(dir, DEFAULT_CONFIG, fusion),
          {
            path: "progress.txt",
            edits: [{ action: "append", body: ["after"] }],
            then_run: { command: "check" },
          },
          {
            ctx: rpcContext,
            onUpdate: (update: ProgressUpdate) => updates.push(update),
          },
        ),
      () =>
        callTool(
          makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
          {
            path: "progress.txt",
            replacements: [{ literal: true, find: "before", replace: "after" }],
            then_run: { command: "check" },
          },
          {
            ctx: rpcContext,
            onUpdate: (update: ProgressUpdate) => updates.push(update),
          },
        ),
      () =>
        callTool(
          makeWriteOverride(dir, fusion),
          {
            path: "progress.txt",
            content: "after\n",
            mode: "overwrite",
            then_run: { command: "check" },
          },
          {
            ctx: rpcContext,
            onUpdate: (update: ProgressUpdate) => updates.push(update),
          },
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
      assert.equal(updates.at(-1)?.details.actionFusion?.command, "succeeded");
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
    const skipped = await callTool(
      makeEditOverride(dir, DEFAULT_CONFIG, fusion),
      {
        path: "missing.txt",
        edits: [{ action: "append", body: ["after"] }],
        then_run: { command: "check" },
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(skipped.isError, true);
    assert.equal(reportOf(skipped, "edit")?.then_run?.status, "skipped");
    assert.equal(reportOf(skipped, "edit")?.publication, "NOT_PUBLISHED");
    assert.equal(skipped.content.length, 1);
    assert.equal(commands, 0);
    assert.deepEqual(
      events.map((event) => event.command),
      ["waiting", "skipped"],
    );
    assert.equal(events.at(-1)?.result, undefined);
    assert.equal(events.at(-1)!.mutationCompleted, false);
    events.length = 0;
    await writeFile(join(dir, "replace.txt"), "original\n");
    const unmatched = await callTool(
      makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
      {
        path: "replace.txt",
        replacements: [{ literal: true, find: "missing", replace: "changed" }],
        then_run: { command: "check" },
      },
      { ctx: await ctx(dir, t) },
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
    const failed = await callTool(
      makeWriteOverride(dir, fusion),
      {
        path: "failed.txt",
        content: "published\n",
        mode: "create",
        then_run: { command: "check" },
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(reportOf(failed, "write")?.then_run?.status, "failed");
    assert.equal(reportOf(failed, "write")?.publication, "PUBLISHED");
    assert.equal(
      reportOf(failed, "write")?.then_run?.output,
      "diagnostic\nCommand exited with code 7",
    );
    assert.equal(failed.content.length, 1);
    assert.equal(commands, 1);
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

test("case-differing paths on Windows → the Fusion queue serializes mutation start and completion", {
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

test("timed command stays silent → heartbeat preserves output and stops after every terminal outcome", async (t) => {
  for (const outcome of ["succeeded", "failed", "timeout", "cancelled"] as const) {
    await t.test(outcome, async (t) => {
      const dir = await tempDir();
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<CommandCompletion>();
      const controller = new AbortController();
      const events: ActionFusionProgress[] = [];
      const updates: unknown[] = [];
      try {
        const fusion = createActionFusionExecutor(
          async (input, _signal, _ctx, onUpdate) => {
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

test("command omits timeout → no countdown events occur while it waits", async (t) => {
  const dir = await tempDir();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<CommandCompletion>();
  const events: ActionFusionProgress[] = [];
  try {
    const fusion = createActionFusionExecutor(
      async (input) => {
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

test("command returns a terminal status → reports its status and diagnostic once without rolling back", async (t) => {
  const dir = await tempDir();
  try {
    const context = await ctx(dir, t);
    for (const status of ["failed", "timeout", "cancelled"] as const) {
      const target = join(dir, `${status}.txt`);
      let commands = 0;
      const fusion = createActionFusionExecutor(async () => {
        commands++;
        return { status, result: { content: [{ type: "text", text: "command diagnostic" }] } };
      });
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        { path: target, content: "published\n", mode: "create", then_run: { command: "check" } },
        { ctx: context },
      );
      const report = reportOf(result, "write");
      assert.equal(result.isError, undefined);
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.then_run?.status, status);
      assert.equal(report?.then_run?.output, "command diagnostic");
      assert.equal(result.content.length, 1);
      const diagnostic = result.content[0];
      assert.ok(diagnostic.type === "text");
      assert.equal((diagnostic.text.match(/"then_run"/g) ?? []).length, 1);
      assert.equal((diagnostic.text.match(/command diagnostic/g) ?? []).length, 1);
      assert.doesNotMatch(
        diagnostic.text,
        /the command was not run|then_run did not complete successfully/,
      );
      assert.equal(commands, 1);
      assert.equal(await readFile(target, "utf8"), "published\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

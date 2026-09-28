import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  THEN_RUN_SUCCEEDED,
} from "./action-fusion.ts";
import { byteRevision, FileMutationError } from "./file-commit.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hashline-action-fusion-"));
}

const ctx = (cwd: string) => ({ cwd }) as ExtensionContext;

test("mutation tools expose Fusion schemas and guidance when supplied an executor", () => {
  const fusion = createActionFusionExecutor();
  for (const makeTool of [makeEditOverride, makeReplaceTool, makeWriteOverride]) {
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

test("edit and replace share one embedded executor and preserve mutation results", async () => {
  const dir = await tempDir();
  try {
    const calls: string[] = [];
    const fusion = createActionFusionExecutor(async (_id, input) => {
      calls.push(input.command);
      return "checked";
    });
    const edit = makeEditOverride(dir, fusion);
    const replace = makeReplaceTool(dir, fusion);
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
      ctx(dir),
    );
    const replaceResult = await replace.execute(
      "replace-1",
      {
        path: "replace.txt",
        find: "before",
        replace: "after",
        then_run: { command: "check replace" },
      },
      undefined,
      undefined,
      ctx(dir),
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

test("mutation failure skips the command and command failure does not roll back", async () => {
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
        ctx: ctx(dir),
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
      mutate: async () => ({
        content: [{ type: "text", text: "mutation" }],
        details: { ok: true, publishedRevision: byteRevision("changed\n") },
      }),
      signal: undefined,
      ctx: ctx(dir),
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

test("cancelled calls do not mutate or run the command", async () => {
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
          return { content: [], details: undefined };
        },
        signal: controller.signal,
        ctx: ctx(dir),
      }),
    );
    assert.equal(mutated, false);
    assert.equal(commanded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default runner executes a real local command", async () => {
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
        return {
          content: [{ type: "text", text: "mutated" }],
          details: { ok: true, publishedRevision: byteRevision("after\n") },
        };
      },
      signal: undefined,
      ctx: {
        ...ctx(dir),
        sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
      } as any,
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

test("marks anchors stale when then_run changes the target", async () => {
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
        return {
          content: [{ type: "text", text: "mutated" }],
          details: { publishedRevision: byteRevision("after mutation\n") },
        };
      },
      signal: undefined,
      ctx: ctx(dir),
    });
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.match(output, /\[then_run:stale\]/);
    assert.equal((result.details as any)?.actionFusion?.freshness, "changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Action Fusion omits structured anchors when target freshness is unknown", async () => {
  const dir = await tempDir();
  try {
    const missing = join(dir, "never-created.txt");
    let commands = 0;
    const fusion = createActionFusionExecutor(async () => {
      commands++;
      return "unexpected";
    });
    const result = await fusion({
      toolCallId: "unknown",
      absolutePath: missing,
      thenRun: { command: "check" },
      mutate: async () => ({ content: [{ type: "text", text: "mutated" }], details: {} }),
      finalizeMutation: (mutation, publishAnchors) => ({
        ...mutation,
        content: [{ type: "text", text: `mutated${publishAnchors ? " ANCHOR" : ""}` }],
      }),
      signal: undefined,
      ctx: ctx(dir),
    });
    const output = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.equal(commands, 0);
    assert.equal((result.details as any).actionFusion.freshness, "unknown");
    assert.doesNotMatch(output, /ANCHOR/);
    assert.match(output, /Pre-command anchors are omitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit omits Updated anchors when then_run changes the target", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "edit-stale.txt");
    await writeFile(target, "before\n");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "command changed\n");
      return "changed";
    });
    const result = await makeEditOverride(dir, fusion).execute(
      "edit-stale",
      {
        path: "edit-stale.txt",
        edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "before")}`, body: ["after"] }],
        then_run: { command: "change target" },
      },
      undefined,
      undefined,
      ctx(dir),
    );
    const output = result.content.map((block: any) => block.text ?? "").join("\n");
    assert.ok(result.details.actionFusion);
    assert.equal(result.details.actionFusion.freshness, "changed");
    assert.match(output, /Pre-command anchors are omitted/);
    assert.doesNotMatch(output, /Updated anchors|\b1#[0-9A-Z]+│/);
    assert.equal(await readFile(target, "utf8"), "command changed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all mutation tools forward command progress before completion in RPC mode", async () => {
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
    const cases = [
      () =>
        makeEditOverride(dir, fusion).execute(
          "edit",
          {
            path: "progress.txt",
            edits: [{ op: "append", body: ["after"] }],
            then_run: { command: "check" },
          },
          undefined,
          (update) => updates.push(update),
          { ...ctx(dir), mode: "rpc" },
        ),
      () =>
        makeReplaceTool(dir, fusion).execute(
          "replace",
          {
            path: "progress.txt",
            find: "before",
            replace: "after",
            then_run: { command: "check" },
          },
          undefined,
          (update) => updates.push(update),
          { ...ctx(dir), mode: "rpc" },
        ),
      () =>
        makeWriteOverride(dir, fusion).execute(
          "write",
          { path: "progress.txt", content: "after\n", then_run: { command: "check" } },
          undefined,
          (update) => updates.push(update),
          { ...ctx(dir), mode: "rpc" },
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

test("progress reports skipped mutations and failed commands without rolling back", async () => {
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
      makeEditOverride(dir, fusion).execute(
        "skip",
        {
          path: "missing.txt",
          edits: [{ op: "append", body: ["after"] }],
          then_run: { command: "check" },
        },
        undefined,
        undefined,
        ctx(dir),
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
      makeReplaceTool(dir, fusion).execute(
        "replace-skip",
        {
          path: "replace.txt",
          find: "missing",
          replace: "changed",
          then_run: { command: "check" },
        },
        undefined,
        undefined,
        ctx(dir),
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
      { path: "failed.txt", content: "published\n", then_run: { command: "check" } },
      undefined,
      undefined,
      ctx(dir),
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

test("concurrent mutations on case-differing paths serialize on Windows", async () => {
  if (process.platform !== "win32") return;
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
        return { content: [], details: { publication: "PUBLISHED" as const } };
      },
      signal: undefined,
      ctx: ctx(dir),
    });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = fusion({
      toolCallId: "2",
      absolutePath: join(dir, "CASETEST.TXT"),
      thenRun: undefined,
      mutate: async () => {
        order.push("start-2");
        order.push("end-2");
        return { content: [], details: { publication: "PUBLISHED" as const } };
      },
      signal: undefined,
      ctx: ctx(dir),
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

test("ActionFusionError re-wrapping appends recovery guidance without duplicating outcome banners", async () => {
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
        ctx: ctx(dir),
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

test("ActionFusion rejects missing or invalid then_run command definitions defensively", async () => {
  const dir = await tempDir();
  try {
    const fusion = createActionFusionExecutor();
    for (const invalid of [
      {},
      { command: null },
      { command: 123 },
      { command: "   " },
      null as any,
    ]) {
      await assert.rejects(
        fusion({
          toolCallId: "test-invalid-cmd",
          absolutePath: join(dir, "target.txt"),
          thenRun: invalid as any,
          mutate: async () => ({ content: [{ type: "text", text: "mutated" }], details: {} }),
          signal: undefined,
          ctx: ctx(dir),
        }),
        { message: "then_run command must not be empty" },
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

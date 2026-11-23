import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { openTestSession, responseStream } from "../testing/session.testing.ts";
import {
  SCRIPT_OUTPUT_SCHEMAS,
  type ActionFusionProgress,
  type CommandStatus,
} from "../pi/report-schema.ts";
import { createActionFusionScheduler, observeFusionToolCall } from "../pi/action-fusion.ts";
import type { ThenRunInput } from "../pi/fusion-arguments.ts";
import { DEFAULT_OUTPUT_BUDGETS, makeWriteOverride } from "../pi/tool-factories.testing.ts";
import { contentText } from "@earendil-works/pi-ai";
import { reportOf } from "../pi/report.ts";

/** Exercise the default runner through a real parent tool call, with no provider traffic. */
async function openSession(
  t: TestContext,
  configure?: (pi: ExtensionAPI, cwd: string) => void,
  onProgress?: (event: ActionFusionProgress) => void,
) {
  const calls: { name: string; parent?: string }[] = [];
  const progress: ActionFusionProgress[] = [];
  const { cwd, session, model } = await openTestSession(t, {
    tools: ["write", "bash"],
    configure(pi, cwd) {
      pi.on("tool_call", (event) => {
        calls.push({ name: event.toolName, parent: event.parentToolCallId });
      });
      pi.on("tool_call", observeFusionToolCall);
      configure?.(pi, cwd);
      pi.registerTool(
        makeWriteOverride(
          cwd,
          createActionFusionScheduler((event) => {
            progress.push(event);
            onProgress?.(event);
          }),
        ),
      );
    },
  });
  return {
    cwd,
    session,
    calls,
    progress,
    abort: () => session.abort(),
    async run(thenRun: ThenRunInput, expectedFile: string | null = "saved\n") {
      let responses = 0;
      session.agent.streamFunction = () => {
        const first = responses++ === 0;
        assert.ok(responses <= 2, "Unexpected model request");
        return responseStream(model, {
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "fused",
                  name: "write",
                  arguments: {
                    path: "saved.txt",
                    mode: "create",
                    content: "saved\n",
                    then_run: thenRun,
                  },
                },
              ]
            : [{ type: "text", text: "Done." }],
          stopReason: first ? "toolUse" : "stop",
        });
      };
      let bashResult: AgentToolResult<unknown> | undefined;
      let writeResult: AgentToolResult<unknown> | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "tool_execution_end") return;
        if (event.toolName === "bash" && event.parentToolCallId === "fused") {
          bashResult = event.result;
        }
        if (event.toolCallId === "fused") writeResult = event.result;
      });
      try {
        await session.prompt("Run the requested local command after the mutation.");
      } finally {
        unsubscribe();
      }
      assert.ok(writeResult, "The mutation must complete through Pi");
      assert.equal(session.agent.state.errorMessage, undefined);
      const result = session.agent.state.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "fused",
      );
      assert.ok(result?.role === "toolResult");
      assert.equal(result.isError, false, "A command failure must not fail the completed mutation");
      const saved = readFile(join(cwd, "saved.txt"), "utf8");
      if (expectedFile === null) await assert.rejects(saved, { code: "ENOENT" });
      else assert.equal(await saved, expectedFile);
      return {
        modelRequests: responses,
        report: reportOf(result, "write"),
        content: result.content,
        bashResult,
        structuredContent: writeResult.structuredContent,
        text: result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      };
    },
  };
}

type FusedResult = Awaited<ReturnType<Awaited<ReturnType<typeof openSession>>["run"]>>;

function assertNativeContent(result: FusedResult, status: CommandStatus) {
  assert.ok(result.bashResult, "Pi must emit the nested Bash result");
  assert.deepEqual(result.content.slice(0, -1), result.bashResult.content);
  assert.deepEqual(reportOf({ content: result.content }, "write")?.then_run, { status });
  assert.ok(Value.Check(SCRIPT_OUTPUT_SCHEMAS.write, result.structuredContent));
  return result.bashResult.structuredContent;
}

const commandCases: {
  name: string;
  source: string;
  timeout?: number;
  command: CommandStatus;
  output?: string;
  exitCode?: number;
  diagnostic: RegExp;
}[] = [
  {
    name: "successful exit",
    source: "console.log('checked');",
    command: "succeeded",
    output: "checked\n",
    exitCode: 0,
    diagnostic: /checked/,
  },
  {
    name: "silent success",
    source: "",
    command: "succeeded",
    output: "",
    exitCode: 0,
    diagnostic: /\(no output\)/,
  },
  {
    name: "nonzero exit with timeout in its output",
    source: "console.error('timeout regression failed'); process.exit(1);",
    command: "failed",
    output: "timeout regression failed\n",
    exitCode: 1,
    diagnostic: /Command exited with code 1/,
  },
  {
    name: "nonzero exit with a timeout-shaped log line",
    source: "console.error('Command timed out after 60 seconds'); process.exit(7);",
    timeout: 60,
    command: "failed",
    output: "Command timed out after 60 seconds\n",
    exitCode: 7,
    diagnostic: /Command exited with code 7/,
  },
  {
    name: "actual timeout",
    source: "setTimeout(() => {}, 10_000);",
    timeout: 0.2,
    command: "timeout",
    diagnostic: /Command timed out after 0\.2 seconds/,
  },
];
for (const { name, source, timeout, command, diagnostic, output, exitCode } of commandCases) {
  test(`real session ${name} → preserves the command outcome and published file`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await openSession(t);
    await writeFile(join(f.cwd, "command.mjs"), source);
    const result = await f.run({
      command: "node command.mjs",
      ...(timeout === undefined ? {} : { timeout }),
    });
    assert.equal(result.report?.publication, "PUBLISHED");
    assert.equal(result.report?.then_run?.status, command);
    assert.equal(result.report?.freshness, undefined);
    assert.match(result.text, diagnostic);
    assert.equal(f.progress.at(-1)?.command, command);
    const native = assertNativeContent(result, command);
    if (exitCode === undefined) {
      assert.equal(native, undefined);
      assert.deepEqual(result.structuredContent, {
        publication: "PUBLISHED",
        then_run: { status: command },
      });
    } else {
      assert.ok(native && typeof native === "object" && "wall_time_seconds" in native);
      const { wall_time_seconds } = native;
      assert.ok(typeof wall_time_seconds === "number" && wall_time_seconds >= 0);
      assert.deepEqual(native, {
        output,
        exit_code: exitCode,
        truncated: false,
        wall_time_seconds,
      });
      assert.deepEqual(result.structuredContent, {
        publication: "PUBLISHED",
        then_run: { status: command, ...native },
      });
    }
  });
}

const outputRow = `${"x".repeat(2047)}\n`;
for (const { name, bytes, structuredTruncated } of [
  { name: "model output only", bytes: DEFAULT_MAX_BYTES * 2, structuredTruncated: false },
  { name: "model and script output", bytes: 2 * 1024 * 1024, structuredTruncated: true },
]) {
  test(`real Bash truncates ${name} → the mutation preserves both native results without a second limit`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await openSession(t);
    const rowCount = Math.ceil(bytes / Buffer.byteLength(outputRow));
    const output = `opening\n${outputRow.repeat(rowCount)}last line\n`;
    await writeFile(
      join(f.cwd, "command.mjs"),
      `process.stdout.write("opening\\n" + ${JSON.stringify(outputRow)}.repeat(${rowCount}) + "last line\\n");`,
    );

    const result = await f.run({ command: "node command.mjs" });
    const details = result.bashResult?.details;
    assert.ok(details && typeof details === "object" && "fullOutputPath" in details);
    const { fullOutputPath } = details;
    assert.ok(typeof fullOutputPath === "string");
    t.after(() => rm(fullOutputPath, { force: true }));
    assert.ok(
      (await readFile(fullOutputPath, "utf8")) === output,
      "Bash must retain the entire output in its log",
    );

    const native = result.bashResult?.structuredContent;
    assert.ok(native && typeof native === "object" && "truncated" in native && "output" in native);
    assert.equal(native.truncated, structuredTruncated);
    if (structuredTruncated) {
      assert.ok("full_output_path" in native && native.full_output_path === fullOutputPath);
    } else {
      assert.ok(native.output === output, "Bash must expose the complete output to scripts");
      assert.equal(Object.hasOwn(native, "full_output_path"), false);
    }
    const bashBlock = result.bashResult?.content[0];
    assert.ok(bashBlock?.type === "text");
    assert.ok(Buffer.byteLength(bashBlock.text) > DEFAULT_OUTPUT_BUDGETS.fieldBytes);
    assert.ok(
      bashBlock.text.includes(fullOutputPath),
      "Native model content must point to the output file",
    );
    assertNativeContent(result, "succeeded");
    assert.deepEqual(result.structuredContent, {
      publication: "PUBLISHED",
      then_run: { status: "succeeded", ...native },
    });
    assert.deepEqual(f.progress.at(-1)?.result?.content, result.bashResult?.content);
  });
}

test("session Bash hook shortens the timeout → reports the nested timeout", {
  timeout: 15_000,
}, async (t) => {
  const f = await openSession(t, (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash") event.input.timeout = 1;
    });
    pi.on("tool_result", (event) => {
      if (event.toolName === "bash") event.input.timeout = 5;
    });
  });
  await writeFile(join(f.cwd, "command.mjs"), "setTimeout(() => {}, 30_000);\n");
  const result = await f.run({ command: "node command.mjs", timeout: 10 });
  assert.match(result.text, /Command timed out after 1 seconds/);
  assert.equal(result.report?.then_run?.status, "timeout");
});

for (const { name, timeout, hookTimeout } of [
  { name: "silent native Bash delegate", timeout: 0.2 },
  { name: "silent native Bash delegate with a hook-edited timeout", timeout: 10, hookTimeout: 0.2 },
]) {
  test(`${name} → reports the effective timeout without a countdown`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await openSession(t, (pi, cwd) => {
      if (hookTimeout !== undefined) {
        pi.on("tool_call", (event) => {
          if (event.toolName === "bash") event.input.timeout = hookTimeout;
        });
      }
      const native = createBashToolDefinition(cwd);
      pi.registerTool({
        ...native,
        execute(id, input, signal, _onUpdate, ctx) {
          return native.execute(id, input, signal, undefined, ctx);
        },
      });
    });
    await writeFile(join(f.cwd, "command.mjs"), "setTimeout(() => {}, 30_000);\n");
    const result = await f.run({ command: "node command.mjs", timeout });
    assert.equal(result.report?.publication, "PUBLISHED");
    assert.match(result.text, /Command timed out after 0\.2 seconds/);
    assert.ok(f.progress.every((event) => event.timing === undefined));
    assert.equal(result.report?.then_run?.status, "timeout");
  });
}

for (const [freshness, source, expectedFile, status] of [
  ["changed", "fs.writeFileSync('saved.txt', 'after'); process.exitCode = 7;", "after", "failed"],
  ["missing", "fs.unlinkSync('saved.txt');", null, "succeeded"],
] as const) {
  test(`real session command leaves target ${freshness} → reports publication, command status and final freshness`, async (t) => {
    const f = await openSession(t);
    await writeFile(join(f.cwd, "command.mjs"), `import fs from 'node:fs';\n${source}`);
    const result = await f.run({ command: "node command.mjs" }, expectedFile);
    assert.equal(result.report?.publication, "PUBLISHED");
    assert.equal(result.report.then_run?.status, status);
    assert.equal(result.report.freshness, freshness);
    const wire = reportOf({ content: result.content }, "write");
    assert.equal(wire?.freshness, freshness);
    if (freshness === "changed") assert.match(wire.next ?? "", /Read the file/);
    else assert.equal(wire.next, undefined);
  });
}

test("cancelling a real session Bash command → reports cancellation and keeps the published mutation", {
  timeout: 15_000,
}, async (t) => {
  const started = Promise.withResolvers<void>();
  const f = await openSession(t, undefined, (event) => {
    if (
      event.command === "running" &&
      event.result &&
      contentText(event.result.content).includes("READY")
    )
      started.resolve();
  });
  await writeFile(
    join(f.cwd, "command.mjs"),
    "console.log('READY'); setInterval(() => {}, 1000);\n",
  );
  const pending = f.run({ command: "node command.mjs" });
  await started.promise;
  await f.abort();
  const result = await pending;
  assert.equal(result.report?.publication, "PUBLISHED");
  assert.equal(result.report?.then_run?.status, "cancelled");
  assert.match(result.text, /Command aborted/);
  assert.equal(f.progress.at(-1)?.command, "cancelled");
});

test("session Bash permission hook rewrites arguments → shows the executed command and its countdown", {
  timeout: 15_000,
}, async (t) => {
  const checking = Promise.withResolvers<void>();
  const allowed = Promise.withResolvers<void>();
  const f = await openSession(t, (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName === "bash") {
        checking.resolve();
        await allowed.promise;
        event.input.command = "echo checked";
        event.input.timeout = 5;
      }
    });
  });
  const pending = f.run({ command: "exit 7", timeout: 10 });
  try {
    await checking.promise;
    assert.ok(f.progress.every((event) => event.timing === undefined));
  } finally {
    allowed.resolve();
    await pending;
  }
  assert.deepEqual(f.progress.find((event) => event.timing)?.timing, {
    timeoutSeconds: 5,
    remainingSeconds: 5,
  });
  assert.equal(f.progress.at(-1)?.command, "succeeded");
  assert.equal(f.progress.find((event) => event.result)?.commandText, "echo checked");
  assert.equal(f.progress.at(-1)?.commandText, "echo checked");
});

test("session Bash permission hook returns a timeout-shaped denial → reports failure without launching", {
  timeout: 15_000,
}, async (t) => {
  const f = await openSession(t, (pi) => {
    pi.on("tool_call", (event) =>
      event.toolName === "bash"
        ? { block: true, reason: "Command timed out after 10 seconds", terminate: true }
        : undefined,
    );
  });
  await writeFile(
    join(f.cwd, "command.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('command-ran', 'yes');\n",
  );
  const result = await f.run({ command: "node command.mjs", timeout: 10 });
  assert.equal(result.report?.publication, "PUBLISHED");
  assert.equal(result.report?.then_run?.status, "failed");
  assert.match(result.text, /Command timed out after 10 seconds/);
  assert.ok(f.progress.every((event) => event.timing === undefined));
  assert.equal(result.modelRequests, 1, "Preserve the policy hook's request to stop the batch");
  await assert.rejects(readFile(join(f.cwd, "command-ran")), { code: "ENOENT" });
  assert.ok(f.calls.some((call) => call.name === "bash" && call.parent === "fused"));
});

const completeOverrideResult = {
  output: "raw override output\n",
  exit_code: 7,
  truncated: false,
  wall_time_seconds: 0.1,
};
for (const { name, structuredContent, expectedStatus, scriptFields, lastBlock } of [
  {
    name: "display content only",
    structuredContent: undefined,
    expectedStatus: "failed" as const,
    scriptFields: {},
    lastBlock: "HOOK_SECOND_BLOCK",
  },
  {
    name: "complete Bash fields",
    structuredContent: completeOverrideResult,
    expectedStatus: "failed" as const,
    scriptFields: completeOverrideResult,
    lastBlock: "HOOK_SECOND_BLOCK",
  },
  {
    name: "partial exit code with a timeout diagnostic",
    structuredContent: { exit_code: 7 },
    expectedStatus: "failed" as const,
    scriptFields: {},
    lastBlock: "Command timed out after 10 seconds",
  },
  {
    name: "non-finite exit code with a timeout diagnostic",
    structuredContent: { exit_code: Number.NaN },
    expectedStatus: "timeout" as const,
    scriptFields: {},
    lastBlock: "Command timed out after 10 seconds",
  },
]) {
  test(`session Bash override with ${name} → preserves hook content and exposes only complete Bash fields`, {
    timeout: 15_000,
  }, async (t) => {
    let executions = 0;
    const partial: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "OVERRIDE_PROGRESS" }],
      details: { fullOutputPath: "/tmp/partial-command.log" },
    };
    const final: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: "HOOK_REJECTED_OVERRIDE" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: lastBlock },
      ],
      details: { fullOutputPath: "/tmp/final-command.log" },
    };
    const f = await openSession(t, (pi, fusionCwd) => {
      pi.registerTool({
        name: "bash",
        label: "bash",
        description: "Session Bash override",
        parameters: createBashToolDefinition(fusionCwd).parameters,
        outputSchema: Type.Partial(
          Type.Object({
            output: Type.String(),
            exit_code: Type.Number(),
            truncated: Type.Boolean(),
            wall_time_seconds: Type.Number(),
          }),
        ),
        async execute(_id, _args, _signal, onUpdate) {
          executions++;
          onUpdate?.(partial);
          return { content: [{ type: "text", text: "OVERRIDE_RESULT" }], details: {} };
        },
      });
      pi.on("tool_result", (event) =>
        event.toolName === "bash"
          ? {
              ...final,
              structuredContent,
              isError: true,
            }
          : undefined,
      );
    });
    await writeFile(
      join(f.cwd, "command.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('command-ran', 'yes');\n",
    );
    const result = await f.run({ command: "node command.mjs", timeout: 10 });
    assert.equal(executions, 1);
    assert.equal(result.report?.then_run?.status, expectedStatus);
    assert.deepEqual(assertNativeContent(result, expectedStatus), structuredContent);
    assert.deepEqual(result.content.slice(0, -1), final.content);
    assert.deepEqual(result.structuredContent, {
      publication: "PUBLISHED",
      then_run: { status: expectedStatus, ...scriptFields },
    });
    assert.deepEqual(
      f.progress.find(
        (event) => event.result && contentText(event.result.content) === "OVERRIDE_PROGRESS",
      )?.result,
      partial,
    );
    assert.deepEqual(f.progress.at(-1)?.result, final);
    await assert.rejects(readFile(join(f.cwd, "command-ran")), { code: "ENOENT" });
    assert.ok(f.calls.some((call) => call.name === "bash" && call.parent === "fused"));
  });
}

test("session listener mutates final command progress → the model keeps the original Bash blocks", async (t) => {
  const f = await openSession(t);
  let observedFinalBlock = false;
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type !== "tool_execution_update" || event.toolCallId !== "fused") return;
    const update: AgentToolResult<{ actionFusion?: ActionFusionProgress }> = event.partialResult;
    const progress = update.details?.actionFusion;
    if (progress?.command !== "succeeded" || progress.freshness !== "unchanged") return;
    const block = progress.result?.content[0];
    if (block?.type !== "text") return;
    observedFinalBlock = true;
    Reflect.set(block, "text", "changed by the progress listener");
  });
  t.after(unsubscribe);

  const result = await f.run({ command: "echo checked" });
  assert.ok(observedFinalBlock, "The listener must see the final command display block");
  assert.match(result.text, /checked/);
  assertNativeContent(result, "succeeded");
});

for (const { name, isError, status, damage } of [
  {
    name: "shadowed array method",
    isError: false,
    status: "succeeded",
    damage(content: AgentToolResult<unknown>["content"]) {
      Object.defineProperty(content, "filter", { value: 0 });
    },
  },
  {
    name: "changing block text",
    isError: false,
    status: "succeeded",
    damage(content: AgentToolResult<unknown>["content"]) {
      let reads = 0;
      Object.defineProperty(content[0], "text", {
        get: () => (reads++ === 0 ? "checked" : "later read"),
      });
    },
  },
  {
    name: "throwing array getter with unreadable cause",
    isError: true,
    status: "failed",
    damage(content: AgentToolResult<unknown>["content"]) {
      const failure = new Error("Unreadable Bash output filter");
      Object.defineProperty(failure, "cause", {
        get() {
          throw new Error("Unreadable cause");
        },
      });
      Object.defineProperty(content, "filter", {
        get() {
          throw failure;
        },
      });
    },
  },
] as const) {
  test(`session Bash result with ${name} → preserves output, publication, command status and termination`, async (t) => {
    const f = await openSession(t, (pi) => {
      pi.registerTool({
        name: "bash",
        label: "bash",
        description: "Session Bash override",
        parameters: Type.Object({ command: Type.String() }),
        async execute() {
          return { content: [{ type: "text", text: "checked" }], details: {}, terminate: true };
        },
      });
      pi.on("tool_result", (event) => (event.toolName === "bash" ? { isError } : undefined));
    });
    let bashEnded = false;
    const unsubscribe = f.session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "bash" &&
        event.parentToolCallId === "fused"
      ) {
        damage(event.result.content);
        bashEnded = true;
      }
    });
    t.after(unsubscribe);

    const result = await f.run({ command: "check" });
    assert.equal(bashEnded, true);
    assert.deepEqual(result.content.slice(0, -1), [{ type: "text", text: "checked" }]);
    assert.deepEqual(f.progress.at(-1)?.result?.content, result.content.slice(0, -1));
    const wire = reportOf({ content: result.content }, "write");
    assert.equal(wire?.publication, "PUBLISHED", result.text);
    assert.equal(wire.then_run?.status, status);
    assert.equal(result.modelRequests, 1, "Preserve the nested result's request to stop the batch");
  });
}

test("session Bash result with unreadable structured output → preserves native content and reports the observer error in details", async (t) => {
  const f = await openSession(t);
  const diagnostic = "Unreadable Bash structured output";
  let observedExitCode: unknown;
  const unsubscribe = f.session.subscribe((event) => {
    if (
      event.type !== "tool_execution_end" ||
      event.toolName !== "bash" ||
      event.parentToolCallId !== "fused"
    )
      return;
    const bash: AgentToolResult<unknown> = event.result;
    const structured = bash.structuredContent;
    if (!structured || typeof structured !== "object" || !("exit_code" in structured)) return;
    observedExitCode = structured.exit_code;
    bash.terminate = true;
    Object.defineProperty(structured, "output", {
      get() {
        throw new Error(diagnostic);
      },
    });
  });
  t.after(unsubscribe);

  const result = await f.run({ command: "exit 7" });
  assert.equal(observedExitCode, 7);
  assert.equal(result.modelRequests, 1, "Preserve the nested command's request to stop the batch");
  assertNativeContent(result, "failed");
  assert.match(result.text, /Command exited with code 7/);
  assert.ok(!result.text.includes(diagnostic), "The observer diagnostic belongs in details only");
  assert.equal(reportOf({ content: result.content }, "write")?.publication, "PUBLISHED");
  assert.deepEqual(result.report?.progressError, { message: diagnostic });
  assert.deepEqual(result.structuredContent, {
    publication: "PUBLISHED",
    then_run: { status: "failed" },
  });
});

test("session Bash override writes the target through a nested call → fails without waiting on its own queue", {
  timeout: 3_000,
}, async (t) => {
  const f = await openSession(t, (pi) => {
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Session Bash override",
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        const nested = await ctx.executeTool("write", {
          path: "./saved.txt",
          mode: "overwrite",
          content: "nested write\n",
        });
        return { ...nested.result, isError: nested.isError };
      },
    });
  });
  const result = await f.run({ command: "check" });
  assert.equal(result.report?.publication, "PUBLISHED");
  assert.equal(result.report?.then_run?.status, "failed");
  assert.ok(f.calls.some((call) => call.name === "write" && call.parent === "fused/1"));
});

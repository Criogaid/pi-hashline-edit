import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openTestSession, responseStream } from "../testing/session.testing.ts";
import type { ActionFusionProgress } from "../pi/report-schema.ts";
import {
  createActionFusionScheduler,
  observeFusionToolCall,
  type ThenRunInput,
} from "../pi/action-fusion.ts";
import { makeWriteOverride } from "../pi/tool-factories.testing.ts";
import { contentText } from "@earendil-works/pi-ai";
import { reportOf } from "../pi/report.ts";
import type { CommandStatus } from "../pi/report-schema.ts";

/** Exercise the default runner through a real parent tool call, with no provider traffic. */
async function openSession(
  t: TestContext,
  configure?: (pi: ExtensionAPI) => void,
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
      configure?.(pi);
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
      await session.prompt("Run the requested local command after the mutation.");
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
        text: result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      };
    },
  };
}

const commandCases: {
  name: string;
  source: string;
  timeout?: number;
  command: CommandStatus;
  diagnostic: RegExp;
}[] = [
  {
    name: "successful exit",
    source: "console.log('checked');",
    command: "succeeded",
    diagnostic: /checked/,
  },
  {
    name: "nonzero exit with timeout in its output",
    source: "console.error('timeout regression failed'); process.exit(1);",
    command: "failed",
    diagnostic: /Command exited with code 1/,
  },
  {
    name: "nonzero exit with a timeout-shaped log line",
    source: "console.error('Command timed out after 60 seconds'); process.exit(7);",
    timeout: 60,
    command: "failed",
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
for (const { name, source, timeout, command, diagnostic } of commandCases) {
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

test("session Bash tool_call blocks then_run → no command side effect, mutation stays published", {
  timeout: 15_000,
}, async (t) => {
  const f = await openSession(t, (pi) => {
    pi.on("tool_call", (event) =>
      event.toolName === "bash"
        ? { block: true, reason: "BLOCKED_BY_POLICY", terminate: true }
        : undefined,
    );
  });
  await writeFile(
    join(f.cwd, "command.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('command-ran', 'yes');\n",
  );
  const result = await f.run({ command: "node command.mjs" });
  assert.equal(result.report?.publication, "PUBLISHED");
  assert.equal(result.report?.then_run?.status, "failed");
  assert.match(result.text, /BLOCKED_BY_POLICY/);
  assert.equal(result.modelRequests, 1, "Preserve the policy hook's request to stop the batch");
  await assert.rejects(readFile(join(f.cwd, "command-ran")), { code: "ENOENT" });
  assert.ok(f.calls.some((call) => call.name === "bash" && call.parent === "fused"));
});

test("session Bash override and tool_result hook → then_run uses their final result", {
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
    ],
    details: { fullOutputPath: "/tmp/final-command.log" },
  };
  const f = await openSession(t, (pi) => {
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Session Bash override",
      parameters: Type.Object({ command: Type.String() }),
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
            isError: true,
          }
        : undefined,
    );
  });
  await writeFile(
    join(f.cwd, "command.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('command-ran', 'yes');\n",
  );
  const result = await f.run({ command: "node command.mjs" });
  assert.equal(executions, 1);
  assert.equal(result.report?.then_run?.status, "failed");
  assert.match(result.text, /HOOK_REJECTED_OVERRIDE/);
  assert.doesNotMatch(result.text, /OVERRIDE_RESULT/);
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

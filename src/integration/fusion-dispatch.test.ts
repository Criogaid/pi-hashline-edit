import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createActionFusionExecutor,
  type ActionFusionDetails,
  type ActionFusionProgress,
  type ThenRunInput,
} from "../pi/action-fusion.ts";
import { makeWriteOverride } from "../pi/write-tool.ts";

/** Exercise the default runner through a real parent tool call, with no provider traffic. */
async function openSession(
  t: TestContext,
  configure?: (pi: ExtensionAPI) => void,
  onProgress?: (event: ActionFusionProgress) => void,
) {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-fusion-session-"));
  let dispose: (() => void) | undefined;
  t.after(async () => {
    dispose?.();
    await rm(cwd, { recursive: true, force: true });
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("fusion-test", {
    api: "openai-completions",
    baseUrl: "https://unused.invalid",
    apiKey: "local-test-placeholder",
    models: [
      {
        id: "test",
        name: "Test",
        input: ["text"],
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = modelRuntime.getModel("fusion-test", "test");
  assert.ok(model);
  const calls: { name: string; parent?: string }[] = [];
  const progress: ActionFusionProgress[] = [];
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => {
          calls.push({ name: event.toolName, parent: event.parentToolCallId });
        });
        configure?.(pi);
        pi.registerTool(
          makeWriteOverride(
            cwd,
            createActionFusionExecutor(undefined, (event) => {
              progress.push(event);
              onProgress?.(event);
            }),
          ),
        );
      },
    ],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["write", "bash"],
  });
  dispose = () => session.dispose();
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({});
  return {
    cwd,
    calls,
    progress,
    abort: () => session.abort(),
    async run(thenRun: ThenRunInput) {
      let responses = 0;
      session.agent.streamFunction = () => {
        const first = responses++ === 0;
        assert.ok(responses <= 2, "Unexpected model request");
        const message: AssistantMessage = {
          role: "assistant",
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
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        return stream;
      };
      await session.prompt("Run the requested local command after the mutation.");
      assert.equal(session.agent.state.errorMessage, undefined);
      const result = session.agent.state.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "fused",
      );
      assert.ok(result?.role === "toolResult");
      assert.equal(result.isError, false, "A command failure must not fail the completed mutation");
      assert.equal(await readFile(join(cwd, "saved.txt"), "utf8"), "saved\n");
      return {
        modelRequests: responses,
        state: (result.details as unknown as { actionFusion: ActionFusionDetails }).actionFusion,
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
  command: ActionFusionDetails["command"];
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
    assert.deepEqual(result.state, { publication: "PUBLISHED", command, freshness: "unchanged" });
    assert.match(result.text, diagnostic);
    assert.equal(f.progress.at(-1)?.command, command);
  });
}

test("cancelling a real session Bash command → reports cancellation and keeps the published mutation", {
  timeout: 15_000,
}, async (t) => {
  const started = Promise.withResolvers<void>();
  const f = await openSession(t, undefined, (event) => {
    if (event.command === "running" && event.output.includes("READY")) started.resolve();
  });
  await writeFile(
    join(f.cwd, "command.mjs"),
    "console.log('READY'); setInterval(() => {}, 1000);\n",
  );
  const pending = f.run({ command: "node command.mjs" });
  await started.promise;
  await f.abort();
  const result = await pending;
  assert.deepEqual(result.state, {
    publication: "PUBLISHED",
    command: "cancelled",
    freshness: "unchanged",
  });
  assert.match(result.text, /Command aborted/);
  assert.equal(f.progress.at(-1)?.command, "cancelled");
});

test("session Bash permission checks wait → countdown starts with command execution progress", {
  timeout: 15_000,
}, async (t) => {
  const checking = Promise.withResolvers<void>();
  const allowed = Promise.withResolvers<void>();
  const f = await openSession(t, (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName === "bash") {
        checking.resolve();
        await allowed.promise;
      }
    });
  });
  await writeFile(join(f.cwd, "command.mjs"), "console.log('checked');\n");
  const pending = f.run({ command: "node command.mjs", timeout: 10 });
  try {
    await checking.promise;
    assert.ok(f.progress.every((event) => event.timing === undefined));
  } finally {
    allowed.resolve();
    await pending;
  }
  assert.deepEqual(f.progress.find((event) => event.timing)?.timing, {
    timeoutSeconds: 10,
    remainingSeconds: 10,
  });
  assert.equal(f.progress.at(-1)?.command, "succeeded");
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
  assert.deepEqual(result.state, {
    publication: "PUBLISHED",
    command: "failed",
    freshness: "unchanged",
  });
  assert.match(result.text, /BLOCKED_BY_POLICY/);
  assert.equal(result.modelRequests, 1, "Preserve the policy hook's request to stop the batch");
  await assert.rejects(readFile(join(f.cwd, "command-ran")), { code: "ENOENT" });
  assert.ok(f.calls.some((call) => call.name === "bash" && call.parent === "fused"));
});

test("session Bash override and tool_result hook → then_run uses their final result", {
  timeout: 15_000,
}, async (t) => {
  let executions = 0;
  const f = await openSession(t, (pi) => {
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Session Bash override",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions++;
        return { content: [{ type: "text", text: "OVERRIDE_RESULT" }], details: {} };
      },
    });
    pi.on("tool_result", (event) =>
      event.toolName === "bash"
        ? {
            content: [{ type: "text", text: "HOOK_REJECTED_OVERRIDE" }],
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
  assert.deepEqual(result.state, {
    publication: "PUBLISHED",
    command: "failed",
    freshness: "unchanged",
  });
  assert.match(result.text, /HOOK_REJECTED_OVERRIDE/);
  assert.doesNotMatch(result.text, /OVERRIDE_RESULT/);
  await assert.rejects(readFile(join(f.cwd, "command-ran")), { code: "ENOENT" });
  assert.ok(f.calls.some((call) => call.name === "bash" && call.parent === "fused"));
});

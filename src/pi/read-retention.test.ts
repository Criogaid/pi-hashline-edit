import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import extension from "../index.ts";

const TEST_TIMEOUT_MS = 30_000;
const LOG_BODY = "unique log payload to consume once";

type Response = Pick<AssistantMessage, "content" | "stopReason">;
const finish: Response = { content: [{ type: "text", text: "Processed." }], stopReason: "stop" };

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-read-retention-"));
  const path = join(cwd, "build.log");
  await writeFile(path, LOG_BODY);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("retention-test", {
    api: "openai-completions",
    baseUrl: "https://unused.invalid",
    apiKey: "local-test-placeholder",
    models: [
      {
        id: "test",
        name: "Test",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    ],
  });
  const selectedModel = modelRuntime.getModel("retention-test", "test");
  assert.ok(selectedModel);
  const model = selectedModel;
  const sessionManager = SessionManager.inMemory(cwd);
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  t.after(async () => {
    for (const session of sessions) session.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  async function open() {
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
      extensionFactories: [extension],
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      tools: ["read"],
    });
    assert.deepEqual(extensionsResult.errors, []);
    sessions.push(session);
    const requests: Message[][] = [];
    const responses: Response[] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const response = responses.shift();
      assert.ok(response, "Every model request must have a scripted response");
      const message: AssistantMessage = {
        role: "assistant",
        ...response,
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
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        assert.ok(message.stopReason !== "pending");
        stream.push({ type: "done", reason: message.stopReason, message });
      }
      return stream;
    };
    await session.bindExtensions({});
    return {
      session,
      requests,
      async prompt(...next: Response[]) {
        responses.push(...next);
        await session.prompt("Continue.");
        assert.equal(
          responses.length,
          0,
          session.agent.state.errorMessage ?? "Scripted responses remain",
        );
      },
    };
  }
  function read(id: string, ephemeral?: boolean): ToolCall {
    return {
      type: "toolCall",
      id,
      name: "read",
      arguments: { path, ...(ephemeral === undefined ? {} : { ephemeral }) },
    };
  }
  return { path, sessionManager, open, read };
}

function result(messages: readonly Message[], id: string) {
  const message = messages.find((item) => item.role === "toolResult" && item.toolCallId === id);
  assert.ok(message?.role === "toolResult");
  assert.equal(message.isError, false);
  return message;
}

function text(message: ReturnType<typeof result>) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("ephemeral and ordinary reads → only consumed ephemeral bodies expire before the next request", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const f = await fixture(t);
  const run = await f.open();
  await run.prompt(
    { content: [f.read("once", true), f.read("normal")], stopReason: "toolUse" },
    { content: [f.read("later", true)], stopReason: "toolUse" },
    finish,
  );
  assert.ok(text(result(run.requests[1], "once")).includes(LOG_BODY));
  assert.ok(!text(result(run.requests[2], "once")).includes(LOG_BODY));
  assert.ok(text(result(run.requests[2], "normal")).includes(LOG_BODY));
  assert.ok(text(result(run.requests[2], "later")).includes(LOG_BODY));
  await run.prompt(finish);
  const expired = result(run.requests[3], "once");
  assert.deepEqual(expired, result(run.requests[2], "once"));
  assert.ok(text(expired).includes(JSON.stringify(f.path)));
  assert.ok(!text(result(run.requests[3], "later")).includes(LOG_BODY));
  const original = f.sessionManager
    .getEntries()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "once",
    );
  assert.ok(original?.type === "message" && original.message.role === "toolResult");
  assert.ok(text(original.message).includes(LOG_BODY));
  assert.equal(await readFile(f.path, "utf8"), LOG_BODY);
});

for (const stopReason of ["error", "aborted", "length"] as const) {
  test(`${stopReason} response → read body survives retry and expires after success`, {
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    const f = await fixture(t);
    const run = await f.open();
    await run.prompt(
      { content: [f.read("retry", true)], stopReason: "toolUse" },
      { content: [], stopReason },
    );
    assert.ok(text(result(run.requests[1], "retry")).includes(LOG_BODY));
    await run.prompt(finish);
    assert.ok(text(result(run.requests[2], "retry")).includes(LOG_BODY));
    await run.prompt(finish);
    assert.ok(!text(result(run.requests[3], "retry")).includes(LOG_BODY));
  });
}

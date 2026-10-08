/** Real Pi sessions with local model responses and no personal resources or provider traffic. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
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

const TEST_PROVIDER = "hashline-test";
const TEST_CONTEXT_TOKENS = 100_000;
const TEST_OUTPUT_TOKENS = 1000;
export const SESSION_TIMEOUT_MS = 30_000;
export type TestResponse = Pick<AssistantMessage, "content" | "stopReason">;
type TestModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function responseStream(model: TestModel, response: TestResponse) {
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
  assert.ok(message.stopReason !== "pending");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  return stream;
}

export async function openTestSession(
  t: TestContext,
  options: {
    readonly cwd?: string;
    readonly tools: readonly string[];
    readonly configure?: (pi: ExtensionAPI, cwd: string) => void | Promise<void>;
  },
) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "hashline-session-")));
  let dispose: (() => void) | undefined;
  t.after(async () => {
    dispose?.();
    if (options.cwd === undefined) await rm(cwd, { recursive: true, force: true });
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(TEST_PROVIDER, {
    api: "openai-completions",
    baseUrl: "https://unused.invalid",
    apiKey: "local-test-placeholder",
    models: [
      {
        id: "test",
        name: "Test",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: TEST_CONTEXT_TOKENS,
        maxTokens: TEST_OUTPUT_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = modelRuntime.getModel(TEST_PROVIDER, "test");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const configure = options.configure;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: configure ? [(pi) => configure(pi, cwd)] : [],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
    tools: [...options.tools],
  });
  dispose = () => session.dispose();
  assert.deepEqual(extensionsResult.errors, []);
  session.agent.streamFunction = () => {
    throw new Error("Install a scripted response before prompting");
  };
  await session.bindExtensions({});
  return { cwd, session, model, sessionManager };
}

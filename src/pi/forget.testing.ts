/** Real Pi sessions with scripted model responses; no provider requests leave the process. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { openTestSession, responseStream, type TestResponse } from "../testing/session.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { registerForgetTool } from "./forget-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createCodemodeToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";

export { SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
type Response = TestResponse;
type Script = Response | ((messages: readonly Message[]) => Response);
export const finish: Response = {
  content: [{ type: "text", text: "Processed." }],
  stopReason: "stop",
};
export const toolResponse = (...content: ToolCall[]): Response => ({
  content,
  stopReason: "toolUse",
});

/** Extract the public result tag without assuming how its id is generated. */
export function taggedResultId(result: Pick<AgentToolResult<unknown>, "content">) {
  const last = result.content.at(-1);
  return last?.type === "text" ? /^\[result (r[0-9a-f]{5})\]$/.exec(last.text)?.[1] : undefined;
}

export function toolResult(messages: readonly Message[], id: string) {
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  );
  assert.ok(result?.role === "toolResult", `Missing result for ${id}`);
  return result;
}

export function forgetCall(messages: readonly Message[], ...sourceIds: string[]): ToolCall {
  const ids = sourceIds.map((sourceId) => {
    const result = toolResult(messages, sourceId);
    assert.equal(result.isError, false);
    const id = taggedResultId(result);
    assert.ok(id, `Result ${sourceId} must be eligible for forgetting`);
    return id;
  });
  return { type: "toolCall", id: "forget-call", name: "forget", arguments: { ids } };
}

export async function openForgetSession(t: TestContext) {
  const { cwd, session, model, sessionManager } = await openTestSession(t, {
    tools: ["read", "grep", "forget", "codemode"],
    configure(pi, cwd) {
      const config = { ...DEFAULT_CONFIG, forget: true };
      pi.registerTool(makeReadOverride(cwd, config));
      pi.registerTool(makeGrepOverride(cwd, config));
      registerForgetTool(pi);
      pi.registerTool(createCodemodeToolDefinition());
    },
  });
  const requests: Message[][] = [];
  const scripts: Script[] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const script = scripts.shift();
    assert.ok(script, "Unexpected model request after the scripted responses");
    const response = typeof script === "function" ? script(context.messages) : script;
    return responseStream(model, response);
  };
  const rawResult = (id: string) => {
    const entry = sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === id,
      );
    assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
    return entry.message;
  };
  return {
    cwd,
    requests,
    sessionManager,
    rawResult,
    renderForgetCard(expanded = false) {
      const id = "forget-call";
      const tool = session.getToolDefinition("forget");
      assert.ok(tool?.renderResult);
      const call = session.agent.state.messages
        .flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((block) => block.type === "toolCall")
            : [],
        )
        .find((call) => call.id === id);
      assert.ok(call);
      const result = rawResult(id);
      const context: Parameters<typeof tool.renderResult>[3] = {
        args: call.arguments,
        toolCallId: id,
        cwd,
        state: {},
        invalidate() {},
        lastComponent: undefined,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: result.isError,
      };
      initTheme("dark");
      const header = tool.renderCall?.(call.arguments, theme, context);
      const component = tool.renderResult(
        { ...result, details: result.details },
        { expanded, isPartial: false },
        theme,
        context,
      );
      return stripVTControlCharacters(
        [...(header?.render(240) ?? []), ...component.render(240)].join("\n"),
      );
    },
    async requestPayload(index: number) {
      assert.equal(model.api, "openai-completions");
      const messages = requests[index];
      assert.ok(messages);
      let payload: unknown;
      let networkCalls = 0;
      await streamCompletions(
        { ...model, api: "openai-completions" },
        normalizeContext({ messages }),
        {
          apiKey: "local-test-placeholder",
          maxRetries: 0,
          onPayload(value) {
            payload = value;
            throw new Error("Payload captured before sending.");
          },
          async fetch() {
            networkCalls++;
            throw new Error("Provider requests are forbidden in this fixture.");
          },
        },
      ).result();
      assert.ok(payload !== undefined, "Pi must construct the provider payload");
      assert.equal(networkCalls, 0);
      return payload;
    },
    read(id: string, name = "build.log"): ToolCall {
      return { type: "toolCall", id, name: "read", arguments: { path: join(cwd, name) } };
    },
    async prompt(...responses: Script[]) {
      scripts.push(...responses);
      await session.prompt("Continue.");
      assert.equal(
        scripts.length,
        0,
        session.agent.state.errorMessage ?? "Unused scripted responses",
      );
      assert.equal(session.agent.state.errorMessage, undefined);
    },
  };
}

/** The entire model-facing result becomes one receipt, including for image reads. */
export function assertForgotten(result: ReturnType<typeof toolResult>, id: string) {
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  const receipt = result.content[0];
  assert.equal(receipt.type, "text");
  assert.ok(receipt.type === "text" && receipt.text.includes(id));
  assert.ok(receipt.type === "text" && receipt.text.includes("forgotten"));
  assert.equal(taggedResultId(result), undefined);
}

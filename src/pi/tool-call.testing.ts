/**
 * Test support: invoke a tool the way Pi does.
 *
 * In production, input reaches `execute` only after Pi runs the tool's
 * `prepareArguments` and validates (and coerces) the result against the tool
 * schema. `execute` trusts that input, so tests that probe invalid or
 * unusual arguments go through the same funnel instead of calling `execute`.
 */

import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { openTestSession } from "../testing/session.testing.ts";

interface CallableTool extends Tool {
  prepareArguments?(args: unknown): unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<unknown>;
}

export interface ToolCallOptions {
  toolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: unknown;
  ctx?: unknown;
}

/** prepareArguments → schema validation → execute, failing the way Pi reports invalid calls. */
export function callTool<T extends CallableTool>(
  tool: T,
  args: unknown,
  options?: ToolCallOptions,
): ReturnType<T["execute"]>;
export async function callTool(tool: CallableTool, args: unknown, options: ToolCallOptions = {}) {
  const toolCallId = options.toolCallId ?? "test";
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  const validated: unknown = validateToolArguments(tool, {
    type: "toolCall",
    id: toolCallId,
    name: tool.name,
    // Pi owns shape checking and coercion at this external boundary.
    arguments: prepared as ToolCall["arguments"],
  });
  return tool.execute(toolCallId, validated, options.signal, options.onUpdate, options.ctx);
}

/** Create Pi's tool context without loading user credentials or contacting a provider. */
export async function createToolContext(
  cwd: string,
  t: TestContext,
  mode: ExtensionToolContext["mode"] = "json",
) {
  const { session } = await openTestSession(t, { cwd, tools: [] });
  session.extensionRunner.setUIContext(undefined, mode);
  return session.extensionRunner.createToolContext("test", undefined);
}

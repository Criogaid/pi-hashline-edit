/**
 * Test support: invoke a tool the way Pi does.
 *
 * In production, input reaches `execute` only after Pi runs the tool's
 * `prepareArguments` and validates (and coerces) the result against the tool
 * schema. `execute` trusts that input, so tests that probe invalid or
 * unusual arguments go through the same funnel instead of calling `execute`.
 */

import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { openTestSession } from "../testing/session.testing.ts";

interface CallableTool {
  readonly name: string;
  readonly parameters: unknown;
  prepareArguments?(args: unknown): unknown;
  execute(...args: any[]): Promise<any>;
}

export interface ToolCallOptions {
  toolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: unknown;
  ctx?: unknown;
}

/** prepareArguments → schema validation → execute, failing the way Pi reports invalid calls. */
export async function callTool(tool: CallableTool, args: unknown, options: ToolCallOptions = {}) {
  const toolCallId = options.toolCallId ?? "test";
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  const validated = validateToolArguments(tool as never, {
    type: "toolCall",
    id: toolCallId,
    name: tool.name,
    arguments: prepared as never,
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

/**
 * Test support: invoke a tool the way Pi does.
 *
 * In production, input reaches `execute` only after Pi runs the tool's
 * `prepareArguments` and validates (and coerces) the result against the tool
 * schema. `execute` trusts that input, so tests that probe invalid or
 * unusual arguments go through the same funnel instead of calling `execute`.
 */

import { validateToolArguments } from "@earendil-works/pi-ai";

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

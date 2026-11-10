import type { AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TestContext } from "node:test";
import { createToolContext } from "./tool-call.testing.ts";

export type SessionCommand = ExtensionToolContext["executeTool"];

type CommandResult = Omit<AgentToolResult<unknown>, "details"> & {
  readonly details?: unknown;
};

export function commandCompletion(
  result: CommandResult,
  isError = false,
  terminate?: boolean,
  structuredContent?: AgentToolResult<unknown>["structuredContent"],
): AgentToolCallOutcome {
  return {
    toolCall: { type: "toolCall", id: "test/1", name: "bash", arguments: {} },
    result: {
      ...result,
      details: result.details ?? {},
      ...(terminate === undefined ? {} : { terminate }),
      ...(structuredContent === undefined ? {} : { structuredContent }),
    },
    isError,
  };
}

export async function createFusionContext(
  cwd: string,
  t: TestContext,
  executeTool: ExtensionToolContext["executeTool"],
  mode: ExtensionToolContext["mode"] = "json",
) {
  const context = await createToolContext(cwd, t, mode);
  return { ...context, executeTool };
}

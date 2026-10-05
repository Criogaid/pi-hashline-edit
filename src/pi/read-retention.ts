/**
 * Read-result retention uses Pi's branch-local context edits. Raw session entries
 * remain intact. Only results included in a successful model request expire;
 * newly returned tools and failed, cancelled, or incomplete responses do not.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEditEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";

const retentionSchema = Type.Object({
  hashlineEphemeralRead: Type.Object(
    {
      version: Type.Literal(1),
      path: Type.String(),
      offset: Type.Number(POSITIVE_SAFE_INTEGER),
      limit: Type.Number(POSITIVE_SAFE_INTEGER),
    },
    { additionalProperties: false },
  ),
});

type RetentionDetails = Static<typeof retentionSchema>;

/** Persist the resolved read request so reloads do not depend on current defaults. */
export function ephemeralReadDetails(
  path: string,
  offset: number,
  limit: number,
): RetentionDetails {
  return { hashlineEphemeralRead: { version: 1, path, offset, limit } };
}

function expiredText(details: RetentionDetails): string {
  const { path, offset, limit } = details.hashlineEphemeralRead;
  return `[Ephemeral read consumed: ${JSON.stringify(path)} (offset ${offset}, limit ${limit}). Content removed from model context after one successful response. Read again if needed.]`;
}

function pendingRead(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError) return;
  // Details are persisted session input. Unknown versions are left untouched.
  if (!Value.Check(retentionSchema, message.details)) return;
  const placeholder = expiredText(message.details);
  if (
    message.content.length === 1 &&
    message.content[0].type === "text" &&
    message.content[0].text === placeholder
  )
    return;
  return placeholder;
}

export function registerReadRetention(pi: ExtensionAPI): void {
  let includedReads = new Set<string>();
  pi.on("context", (event) => {
    includedReads = new Set(
      event.messages.flatMap((message) =>
        message.role === "toolResult" && pendingRead(message) !== undefined
          ? [message.toolCallId]
          : [],
      ),
    );
  });
  pi.on("turn_end", (event) => {
    const consumed = includedReads;
    includedReads = new Set();
    if (
      event.outcome !== "completed" ||
      event.message.role !== "assistant" ||
      (event.message.stopReason !== "stop" && event.message.stopReason !== "toolUse")
    )
      return;
    const entries: ContextEditEntryDraft[] = [];
    for (const { sourceEntry, messages } of event.context.contextEntries) {
      if (
        sourceEntry.type !== "message" ||
        sourceEntry.message.role !== "toolResult" ||
        !consumed.has(sourceEntry.message.toolCallId)
      )
        continue;
      const toolCallId = sourceEntry.message.toolCallId;
      const visible = messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
      );
      const placeholder = visible && pendingRead(visible);
      if (placeholder !== undefined)
        entries.push({
          type: "context_edit",
          targetId: sourceEntry.id,
          replacement: { content: [{ type: "text", text: placeholder }] },
        });
    }
    if (entries.length > 0) return { entries };
  });
}

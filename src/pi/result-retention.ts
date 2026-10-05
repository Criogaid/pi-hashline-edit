/**
 * Read/grep retention uses Pi's branch-local context edits. Raw session entries
 * remain intact. Only results included in a successful model request expire;
 * newly returned tools and failed, cancelled, or incomplete responses do not.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEditEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";

export const ephemeralParameter = Type.Optional(
  Type.Boolean({
    description:
      "When true, keep this result in model context for one successful response, including a response that calls tools, then replace it with a receipt. Omitted or false keeps normal retention. Failed, cancelled, or output-limit responses keep it for retry. Tool errors and incomplete searches keep their results. Files and session history remain intact.",
  }),
);

const readRetentionSchema = Type.Object({
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

const grepRetentionSchema = Type.Object({
  hashlineEphemeralGrep: Type.Object(
    {
      version: Type.Literal(1),
      patterns: Type.Array(Type.String()),
      paths: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
});

type ReadRetentionDetails = Static<typeof readRetentionSchema>;
type GrepRetentionDetails = Static<typeof grepRetentionSchema>;

const EXPIRY_NOTICE = "Content removed from model context after one successful response.";

/** Persist the resolved read request so reloads do not depend on current defaults. */
export function ephemeralReadDetails(
  path: string,
  offset: number,
  limit: number,
): ReadRetentionDetails {
  return { hashlineEphemeralRead: { version: 1, path, offset, limit } };
}

export function ephemeralGrepDetails(
  patterns: readonly string[],
  paths: readonly string[],
): GrepRetentionDetails {
  return { hashlineEphemeralGrep: { version: 1, patterns: [...patterns], paths: [...paths] } };
}

function expiredReadText(details: ReadRetentionDetails): string {
  const { path, offset, limit } = details.hashlineEphemeralRead;
  return `[Ephemeral read consumed: ${JSON.stringify(path)} (offset ${offset}, limit ${limit}). ${EXPIRY_NOTICE} Read again if needed.]`;
}

function expiredGrepText(details: GrepRetentionDetails): string {
  const { patterns, paths } = details.hashlineEphemeralGrep;
  return `[Ephemeral grep consumed: patterns ${JSON.stringify(patterns)} in ${JSON.stringify(paths)}. ${EXPIRY_NOTICE} Run grep again if needed.]`;
}

function pendingResult(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult" || message.isError) return;
  // Details are persisted session input. Unknown versions are left untouched.
  let placeholder: string;
  if (message.toolName === "read" && Value.Check(readRetentionSchema, message.details)) {
    placeholder = expiredReadText(message.details);
  } else if (message.toolName === "grep" && Value.Check(grepRetentionSchema, message.details)) {
    placeholder = expiredGrepText(message.details);
  } else {
    return;
  }
  if (
    message.content.length === 1 &&
    message.content[0].type === "text" &&
    message.content[0].text === placeholder
  )
    return;
  return placeholder;
}

export function registerResultRetention(pi: ExtensionAPI): void {
  let includedResults = new Set<string>();
  pi.on("context", (event) => {
    includedResults = new Set(
      event.messages.flatMap((message) =>
        message.role === "toolResult" && pendingResult(message) !== undefined
          ? [message.toolCallId]
          : [],
      ),
    );
  });
  pi.on("turn_end", (event) => {
    const consumed = includedResults;
    includedResults = new Set();
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
      const placeholder = visible && pendingResult(visible);
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

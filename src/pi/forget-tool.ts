/**
 * forget: the model drops read/grep results it no longer needs from model context.
 *
 * The decision is made after the model has seen a result, and only in the response
 * that first sees it. read and grep tag results of at least FORGET_MIN_BYTES (and any
 * image) with a `[result rXXXXX]` block derived from the tool call id. Before each
 * request, the `context` handler records the tagged results that follow the last
 * assistant message: the batch the coming response is the first to see. forget may
 * name only those ids. At `turn_end` of a completed response, Pi's branch-local
 * context edits replace each named result's entire content with a forgotten receipt.
 * The tool call and any facts saved in forget's note remain in context.
 *
 * Restricting forget to the newest batch bounds how much of the next request changes:
 * it differs from the earliest replaced result on, which covers later results of the
 * same batch, the response that requested the edit, and its tool results. Messages
 * before that result are unchanged. Editing an older result would change every
 * later message. Raw session entries stay intact; navigating before the edit shows
 * the original result again.
 *
 * @module pi-hashline-edit/pi
 */

import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { FORGET_MIN_BYTES, formatKiB } from "./budgets.ts";
import { renderToolError } from "./render.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

const RESULT_ID = "r[0-9a-f]{5}";
const RESULT_TAG = new RegExp(`^\\[result ${RESULT_ID}\\]$`);

/** Short id shown to the model; it only has to be unique within one tool batch. */
function resultId(toolCallId: string): string {
  return `r${createHash("sha256").update(toolCallId).digest("hex").slice(0, 5)}`;
}

function resultTag(toolCallId: string): string {
  return `[result ${resultId(toolCallId)}]`;
}

type ResultContent = AgentToolResult<unknown>["content"];

function isResultTag(block: ResultContent[number] | undefined, toolCallId: string): boolean {
  return block?.type === "text" && block.text === resultTag(toolCallId);
}

/** Pattern text shown in a grep receipt before it is cut with an ellipsis. */
const MAX_RECEIPT_PATTERN_CHARS = 60;

/**
 * Display-only receipt for a tagged result, kept in its details. Pi does not send details
 * to the model, so the forget card can name what was forgotten without adding context.
 */
export interface ForgetReceiptDetails {
  forgetReceipt?: string;
}

function plural(count: number, noun: string, pluralForm = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralForm}`;
}

/** `path · lines A–B` for anchored text, `path · image` for images, `path` otherwise. */
export function readReceipt(
  path: string,
  shown: { image: true } | { start: number; end: number; truncated: boolean } | undefined,
): string {
  if (!shown) return path;
  if ("image" in shown) return `${path} · image`;
  return `${path} · lines ${shown.start}–${shown.end}${shown.truncated ? " · truncated" : ""}`;
}

/** `grep /pattern/ · N matches in M files`, with limit and incomplete-search notes. */
export function grepReceipt(
  patterns: readonly string[],
  matches: number,
  files: number,
  notes: { limitReached: boolean; incomplete: boolean },
): string {
  const joined = patterns.join(" | ");
  const pattern =
    joined.length > MAX_RECEIPT_PATTERN_CHARS
      ? `${joined.slice(0, MAX_RECEIPT_PATTERN_CHARS)}…`
      : joined;
  let receipt = `grep /${pattern}/ · ${plural(matches, "match", "matches")} in ${plural(files, "file")}`;
  if (notes.limitReached) receipt += " · limit reached";
  if (notes.incomplete) receipt += " · incomplete";
  return receipt;
}

/**
 * Tag a successful read/grep result when forgetting is enabled and the result is
 * eligible. Only then evaluate createReceipt and keep its display text in details.
 */
export function withResultTag<T extends { content: ResultContent; details?: unknown }>(
  toolCallId: string,
  result: T,
  enabled: boolean,
  createReceipt: () => string,
): T {
  if (!enabled) return result;
  const bytes = result.content.reduce(
    (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
    0,
  );
  const hasImage = result.content.some((block) => block.type === "image");
  if (!hasImage && bytes < FORGET_MIN_BYTES) return result;
  return {
    ...result,
    content: [...result.content, { type: "text" as const, text: resultTag(toolCallId) }],
    details: { ...(result.details as object | undefined), forgetReceipt: createReceipt() },
  };
}

function receiptOf(details: unknown): string | undefined {
  const receipt = (details as ForgetReceiptDetails | undefined)?.forgetReceipt;
  return typeof receipt === "string" ? receipt : undefined;
}

/** Drop the tag block before handing a result to a renderer that shows every text block. */
export function withoutResultTag<T extends { content: ResultContent }>(result: T): T {
  const last = result.content.at(-1);
  if (last?.type !== "text" || !RESULT_TAG.test(last.text)) return result;
  return { ...result, content: result.content.slice(0, -1) };
}

const forgetSchema = Type.Object(
  {
    ids: Type.Array(Type.String({ pattern: `^${RESULT_ID}$` }), {
      minItems: 1,
      uniqueItems: true,
      description: "Result ids to forget, from the [result rXXXXX] tags of the previous step.",
    }),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Conclusions needed for subsequent work, kept in context. Omit when none; do not restate the read or forget action.",
      }),
    ),
  },
  { additionalProperties: false },
);
type ForgetParams = Static<typeof forgetSchema>;
/** One line per forgotten result; receipt is absent for results tagged before receipts existed. */
type ForgetDetails = { forgotten: { id: string; receipt?: string }[] };

/** Register the forget tool and the context hooks that apply it. */
export function registerForgetTool(pi: ExtensionAPI): void {
  // Tagged results of the batch the current response is the first to see, by id.
  let forgettable = new Map<string, { toolCallId: string; receipt?: string }>();
  // Results named by forget during the current response, applied at its turn_end.
  let pending = new Set<string>();

  pi.on("context", (event) => {
    forgettable = new Map();
    const lastAssistant = event.messages.findLastIndex((message) => message.role === "assistant");
    // Every tag still visible, older batches included: an id the model can see on more
    // than one result cannot name a single one, so none of them is forgettable.
    const visible = new Map<string, number>();
    event.messages.forEach((message, index) => {
      if (
        message.role !== "toolResult" ||
        message.isError ||
        !isResultTag(message.content.at(-1), message.toolCallId)
      )
        return;
      const id = resultId(message.toolCallId);
      visible.set(id, (visible.get(id) ?? 0) + 1);
      if (index > lastAssistant)
        forgettable.set(id, {
          toolCallId: message.toolCallId,
          receipt: receiptOf(message.details),
        });
    });
    for (const [id, count] of visible) if (count > 1) forgettable.delete(id);
  });

  pi.on("turn_end", (event) => {
    const targets = pending;
    pending = new Set();
    if (event.outcome !== "completed" || targets.size === 0) return;
    const entries: ContextEditEntryDraft[] = [];
    for (const { sourceEntry, messages } of event.context.contextEntries) {
      if (sourceEntry.type !== "message") continue;
      // Edit what the model saw: the projected message, which carries the tag.
      const message = messages.find(
        (candidate) => candidate.role === "toolResult" && targets.has(candidate.toolCallId),
      );
      if (message?.role !== "toolResult") continue;
      entries.push({
        type: "context_edit",
        targetId: sourceEntry.id,
        replacement: {
          content: [
            {
              type: "text",
              text: `[Result ${resultId(message.toolCallId)}: content forgotten; rerun the call to see it again.]`,
            },
          ],
        },
      });
    }
    if (entries.length > 0) return { entries };
  });

  pi.registerTool({
    name: "forget",
    label: "forget",
    description: `Remove read or grep results from your context once you have taken what you need. Only results from the previous step tagged [result rXXXXX] (${formatKiB(FORGET_MIN_BYTES)} or larger, or images) can be forgotten. After this response each selected result's entire content, including headers and notices, is replaced with a forgotten receipt. Save facts you still need in note. Files and session history are unchanged.`,
    promptSnippet: "Forget read or grep results you no longer need",
    promptGuidelines: [
      "Right after a read or grep result tagged [result rXXXXX], call forget with its id if you will not need any of its content again; put facts you still need in note. Results from earlier steps cannot be forgotten.",
    ],
    parameters: forgetSchema,
    prepareArguments: createArgumentPreparer("forget", forgetSchema),
    renderShell: "default" as const,
    renderCall(args: ForgetParams, theme: Theme) {
      let text =
        theme.fg("toolTitle", theme.bold("forget")) +
        (Array.isArray(args?.ids)
          ? theme.fg("dim", ` · ${plural(args.ids.length, "result")}`)
          : "");
      if (typeof args?.note === "string") text += `\n${theme.fg("dim", args.note)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context?.isError) return renderToolError(result, theme, expanded);
      const forgotten = result.details?.forgotten ?? [];
      return new Text(
        forgotten
          .map(
            ({ id, receipt }) =>
              (expanded && receipt ? theme.fg("dim", `${id} · `) : "") +
              theme.fg("toolOutput", receipt ?? id),
          )
          .join("\n"),
        0,
        0,
      );
    },
    async execute(_toolCallId: string, params: ForgetParams) {
      const unknown = params.ids.filter((id) => !forgettable.has(id));
      if (unknown.length > 0) {
        const available = [...forgettable.keys()];
        throw new Error(
          `Cannot forget ${unknown.join(", ")}: only tagged read or grep results from the previous step can be forgotten.${available.length ? ` Available: ${available.join(", ")}.` : ""}`,
        );
      }
      const forgotten = params.ids.map((id) => {
        const { toolCallId, receipt } = forgettable.get(id)!;
        pending.add(toolCallId);
        return { id, receipt };
      });
      return {
        content: [{ type: "text" as const, text: `Forgot ${params.ids.join(", ")}.` }],
        details: { forgotten },
      };
    },
  } satisfies ToolDefinition<typeof forgetSchema, ForgetDetails>);
}

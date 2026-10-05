/**
 * forget: the model drops read/grep results it no longer needs from model context.
 *
 * The decision is made after the model has seen a result, and only in the response
 * that first sees it. read and grep tag results of at least FORGET_MIN_BYTES (and any
 * image) with a `[result rXXXXX]` block derived from the tool call id. Before each
 * request, the `context` handler records the tagged results that follow the last
 * assistant message: the batch the coming response is the first to see. forget may
 * name only those ids. At `turn_end` of a completed response, each named result loses
 * only its document content through Pi's branch-local context edits: file rows and
 * images are dropped, while headers, pagination, truncation and search notices stay,
 * so the model still knows what the call returned and how to fetch it again.
 *
 * Restricting forget to the newest batch keeps prompt-cache cost bounded: the edit
 * sits right before the response that requested it, so the next request re-sends only
 * that response and its tool results. Editing an older result would re-send every
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
import { parseDisplayRow } from "./anchor-format.ts";

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

/** Tag a successful read/grep result as forgettable when it is worth forgetting. */
export function withResultTag<T extends { content: ResultContent }>(
  toolCallId: string,
  result: T,
): T {
  const bytes = result.content.reduce(
    (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
    0,
  );
  const hasImage = result.content.some((block) => block.type === "image");
  if (!hasImage && bytes < FORGET_MIN_BYTES) return result;
  return {
    ...result,
    content: [...result.content, { type: "text" as const, text: resultTag(toolCallId) }],
  };
}

/** Drop the tag block before handing a result to a renderer that shows every text block. */
export function withoutResultTag<T extends { content: ResultContent }>(result: T): T {
  const last = result.content.at(-1);
  if (last?.type !== "text" || !RESULT_TAG.test(last.text)) return result;
  return { ...result, content: result.content.slice(0, -1) };
}

function forgottenLines(count: number): string {
  return `… ${count} line${count === 1 ? "" : "s"} forgotten`;
}

/**
 * Drop the document content of a tagged result. Runs of anchored or plain file rows
 * collapse to one `… N lines forgotten` line and images are dropped; other text stays.
 * A text block with no rows (Pi's built-in read of a NUL-containing file) is document
 * content as a whole unless the result also carries an image, whose text is its note.
 */
function forgetDocumentContent(content: ResultContent, id: string): ResultContent {
  const hasImage = content.some((block) => block.type === "image");
  const kept: ResultContent = [];
  for (const block of content.slice(0, -1)) {
    if (block.type !== "text") continue;
    const lines: string[] = [];
    let run = 0;
    let rows = 0;
    for (const line of block.text.split("\n")) {
      if (parseDisplayRow(line)) {
        run++;
        continue;
      }
      if (run) lines.push(forgottenLines(run));
      rows += run;
      run = 0;
      lines.push(line);
    }
    if (run) lines.push(forgottenLines(run));
    rows += run;
    if (rows > 0 || hasImage) kept.push({ type: "text", text: lines.join("\n") });
  }
  const notice = `[Result ${id}: document content forgotten; rerun the call to see it again.]`;
  return [...kept, { type: "text", text: notice }];
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
        description: "Facts from these results you still need; stays in context with this call.",
      }),
    ),
  },
  { additionalProperties: false },
);
type ForgetParams = Static<typeof forgetSchema>;

/** Register the forget tool and the context hooks that apply it. */
export function registerForgetTool(pi: ExtensionAPI): void {
  // Tagged results of the batch the current response is the first to see: id → toolCallId.
  let forgettable = new Map<string, string>();
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
      if (index > lastAssistant) forgettable.set(id, message.toolCallId);
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
          content: forgetDocumentContent(message.content, resultId(message.toolCallId)),
        },
      });
    }
    if (entries.length > 0) return { entries };
  });

  pi.registerTool({
    name: "forget",
    label: "forget",
    description: `Remove the file content of read or grep results from your context once you have taken what you need. Only results from the previous step tagged [result rXXXXX] (${formatKiB(FORGET_MIN_BYTES)} or larger, or images) can be forgotten. After this response their file rows and images are removed; headers, pagination and search notices stay. Files and session history are unchanged. Calling forget alone ends your turn; call it together with your next tool calls to keep working.`,
    promptSnippet: "Forget read or grep results you no longer need",
    promptGuidelines: [
      "Right after a read or grep result tagged [result rXXXXX], call forget with its id if you will not need its file content or anchors again; put facts you still need in note. Results from earlier steps cannot be forgotten.",
    ],
    parameters: forgetSchema,
    renderShell: "default" as const,
    renderCall(args: ForgetParams, theme: Theme) {
      let text =
        theme.fg("toolTitle", theme.bold("forget ")) +
        theme.fg("accent", Array.isArray(args?.ids) ? args.ids.join(", ") : "");
      if (typeof args?.note === "string") text += `\n${theme.fg("dim", args.note)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context?.isError) return renderToolError(result, theme, expanded);
      return new Text("", 0, 0);
    },
    async execute(_toolCallId: string, params: ForgetParams) {
      const unknown = params.ids.filter((id) => !forgettable.has(id));
      if (unknown.length > 0) {
        const available = [...forgettable.keys()];
        throw new Error(
          `Cannot forget ${unknown.join(", ")}: only tagged read or grep results from the previous step can be forgotten.${available.length ? ` Available: ${available.join(", ")}.` : ""}`,
        );
      }
      for (const id of params.ids) pending.add(forgettable.get(id)!);
      return {
        content: [{ type: "text" as const, text: `Forgot ${params.ids.join(", ")}.` }],
        details: undefined,
        terminate: true,
      };
    },
  } satisfies ToolDefinition<typeof forgetSchema, undefined>);
}

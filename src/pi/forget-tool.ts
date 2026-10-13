/**
 * forget: the model drops tagged inspection output it no longer needs from context.
 *
 * Direct read/grep results and codemode outputs containing successful inspections
 * are tagged when they meet the output budget. Nested read/grep results lose their
 * tags before reaching the script: Pi persists only the script's final output,
 * which is forgotten as one result even when the script transforms or mixes data.
 * A tag is the `resultId` fact of the result's report (report.ts), owned by
 * forget alone. Before each request, the `context` handler records the tagged results
 * of the previous response, the only ones forget may name. Other named ids are reported
 * without blocking the rest, since no later response can forget them either. At
 * `turn_end` of a completed response, branch-local context edits replace each named
 * result with a receipt report.
 * The tool call and any facts saved in forget's note remain in context.
 *
 * Restricting forget to the previous response bounds how much of the next request
 * changes, and how often: it differs from the earliest replaced result on, which covers
 * later results of the same batch, the response that requested the edit, and its tool
 * results. Messages before that result are unchanged. Editing an older result would
 * change every later message, and forgetting one batch across several responses would
 * change the request once per response. Raw session entries stay intact; navigating
 * before the edit shows the original result again.
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
import {
  defaultOutputBudgets,
  FORGET_MIN_BYTES,
  formatKiB,
  type OutputBudgetProvider,
} from "./budgets.ts";
import { renderToolError } from "./render.ts";
import {
  decodeReport,
  reportOf,
  reportResult,
  runTool,
  type Report,
  type ReportDetails,
} from "./report.ts";
import { HashlineError } from "../core/errors.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

const RESULT_ID = "r[0-9a-f]{5}";
const CODEMODE_FORGET_SCOPE = "entire codemode output, including all text and images";
const CODEMODE_FORGET_RECEIPT = "codemode · entire output";

/** Short id shown to the model; it only has to be unique within one tool batch. */
function resultId(toolCallId: string): string {
  return `r${createHash("sha256").update(toolCallId).digest("hex").slice(0, 5)}`;
}

type ResultContent = AgentToolResult<unknown>["content"];

/** Whether the model saw this result tagged: its last block is a report naming the call's id. */
function isTagged(content: ResultContent, toolCallId: string, toolName: string): boolean {
  const last = content.at(-1);
  return (
    last?.type === "text" && decodeReport(last.text, toolName)?.resultId === resultId(toolCallId)
  );
}

/** Text results below the threshold save too little to be worth forgetting; images always qualify. */
function worthForgetting(content: ResultContent): boolean {
  const bytes = content.reduce(
    (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
    0,
  );
  return content.some((block) => block.type === "image") || bytes >= FORGET_MIN_BYTES;
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
 * Build a successful read/grep result, tagged when forgetting is enabled and the
 * result is eligible. Only then evaluate createReceipt and keep its display text in details.
 */
export function withResultTag<TDetails extends object | undefined>(
  toolCallId: string,
  parts: { report: Report; payload: ResultContent; details?: TDetails },
  enabled: boolean,
  createReceipt: () => string,
): AgentToolResult<TDetails & ReportDetails & ForgetReceiptDetails> {
  const { report, payload, details } = parts;
  const untagged = reportResult(report, payload, details);
  if (!enabled || !worthForgetting(untagged.content)) return untagged;
  return reportResult({ ...report, resultId: resultId(toolCallId) }, payload, {
    ...details,
    forgetReceipt: createReceipt(),
  } as TDetails & ForgetReceiptDetails);
}

function receiptOf(details: unknown): string | undefined {
  const receipt = (details as ForgetReceiptDetails | undefined)?.forgetReceipt;
  return typeof receipt === "string" ? receipt : undefined;
}

const forgetSchema = Type.Object(
  {
    ids: Type.Array(Type.String({ pattern: `^${RESULT_ID}$` }), {
      minItems: 1,
      uniqueItems: true,
      description: "resultId values to forget.",
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
type ForgetDetails = { forgotten?: { id: string; receipt?: string }[] } & Partial<ReportDetails>;

/** Register the forget tool and the context hooks that apply it. */
export function registerForgetTool(
  pi: ExtensionAPI,
  budgets: OutputBudgetProvider = defaultOutputBudgets,
): void {
  // Tagged results of the batch the current response is the first to see, by id.
  let forgettable = new Map<string, { toolCallId: string; receipt?: string }>();
  // Results named by forget during the current response, applied at its turn_end.
  let pending = new Set<string>();

  pi.on("tool_result", (event) => {
    if (
      !event.parentToolCallId ||
      (event.toolName !== "read" && event.toolName !== "grep") ||
      !isTagged(event.content, event.toolCallId, event.toolName)
    )
      return;
    // A nested id cannot identify a transcript entry: rebuild the report without it.
    const report = reportOf(event)!;
    const { forgetReceipt: _receipt, ...details } = (event.details ?? {}) as ForgetReceiptDetails;
    const result = reportResult(
      { ...report, resultId: undefined },
      event.content.slice(0, -1),
      details,
    );
    // Preserve structured results while removing the tag.
    return { ...result, structuredContent: event.structuredContent };
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (
      message.role !== "toolResult" ||
      message.toolName !== "codemode" ||
      message.isError ||
      !message.nestedCalls?.calls.some(
        (call) =>
          call.status === "ok" &&
          (call.name === "read" ||
            (call.name === "grep" &&
              call.arguments !== undefined &&
              (call.arguments.outputMode == null || call.arguments.outputMode === "content"))),
      )
    )
      return;
    if (!worthForgetting(message.content)) return;
    // The codemode output is not ours: its tag is a report of forget facts alone.
    const tag = reportResult(
      {
        tool: "codemode",
        resultId: resultId(message.toolCallId),
        forgetScope: CODEMODE_FORGET_SCOPE,
      },
      message.content,
    );
    return {
      message: {
        ...message,
        content: tag.content,
        details: {
          ...(message.details as object | undefined),
          forgetReceipt: CODEMODE_FORGET_RECEIPT,
        },
      },
    };
  });

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
        !isTagged(message.content, message.toolCallId, message.toolName)
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
          content: reportResult({
            tool: message.toolName,
            resultId: resultId(message.toolCallId),
            contentForgotten: true,
          }).content,
        },
      });
    }
    if (entries.length > 0) return { entries };
  });

  pi.registerTool({
    name: "forget",
    label: "forget",
    description: `Remove tagged inspection output from your context. Only results of your previous response whose report has a resultId (${formatKiB(FORGET_MIN_BYTES)} or larger, or images) can be forgotten; later responses cannot forget them. After this response each selected result's entire content, including its report, is replaced with a forgotten receipt. A codemode resultId covers its entire output, including other results printed by the script. Files and session history are unchanged.`,
    promptSnippet: "Forget tagged inspection output you no longer need",
    promptGuidelines: [
      "In the response right after results with a resultId, forget each one unless you will need its text after that response's tool results return; anchors you pass to edit in that same response are already in the edit call, so using them is no reason to keep it. First copy any facts you still need into note.",
      "Make that one forget call alongside the response's other tool calls, naming every result to forget; when the response makes no other tool call, skip forget.",
    ],
    parameters: forgetSchema,
    prepareArguments: createArgumentPreparer("forget", forgetSchema, undefined, budgets),
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
      const lines = (result.details?.forgotten ?? []).map(
        ({ id, receipt }) =>
          (expanded && receipt ? theme.fg("dim", `${id} · `) : "") +
          theme.fg("toolOutput", receipt ?? id),
      );
      const notForgettable = result.details?.report?.notForgettable ?? [];
      if (notForgettable.length > 0)
        lines.push(theme.fg("warning", `not forgettable: ${notForgettable.join(", ")}`));
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId: string, params: ForgetParams) {
      return runTool("forget", { budget: budgets() }, async () => {
        // Forget what can be forgotten: no later response could retry the rest.
        const named = params.ids.filter((id) => forgettable.has(id));
        const notForgettable = params.ids.filter((id) => !forgettable.has(id));
        if (named.length === 0)
          throw new HashlineError(
            "NOT_FORGETTABLE",
            "No id names a tagged result of the previous response.",
            { facts: { notForgettable } },
          );
        const forgotten = named.map((id) => {
          const { toolCallId, receipt } = forgettable.get(id)!;
          pending.add(toolCallId);
          return { id, receipt };
        });
        return reportResult(
          {
            tool: "forget",
            forgotten: named,
            ...(notForgettable.length > 0 ? { notForgettable } : {}),
          },
          [],
          { forgotten },
        );
      });
    },
  } satisfies ToolDefinition<typeof forgetSchema, ForgetDetails>);
}

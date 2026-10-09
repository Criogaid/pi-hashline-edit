/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors copied from read / grep / replace output
 * (or from a prior edit's "Updated anchors"). The core verifies each anchor live against
 * the current file content — no prior-read revision guard: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit. The extension requires structured `edits` arrays
 * at execution; Pi may coerce a single object before validation. Legacy
 * oldText/newText inputs fail schema validation before mutation.
 *
 * On success the result carries fresh `LINE#HASH` anchors for the lines this
 * edit produced (and the line that shifted into a deletion gap), so the model
 * can chain edits without a re-read.
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import {
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { applyEdits } from "../core/apply.ts";
import { splitLines } from "../core/lines.ts";
import { unwritableTextError } from "../core/text.ts";
import { EDIT_ANCHOR_FIELDS, type Anchor, type Edit } from "../core/types.ts";
import type { HashlineEditConfig } from "./config.ts";
import {
  anchorPattern,
  createAnchorFormatter,
  parseAnchorToken,
  type AnchorFormatter,
} from "./anchor-format.ts";
import {
  formatDiffCounts,
  renderMutationCall,
  renderMutationResult,
  type DiffCounts,
} from "./render.ts";
import { describeEditFailure } from "./failure-context.ts";
import { formatMutationAnchors } from "./mutation-result.ts";
import {
  executeMutation,
  runTextMutation,
  type ActionFusionExecutor,
  type MutationTarget,
  type TextMutationDetails,
} from "./mutation-runner.ts";
import { MUTATION_TOOL_GUIDELINE } from "./tool-prompts.ts";
import {
  argumentItems,
  createArgumentPreparer,
  type ReportArgumentIssue,
} from "./argument-validation.ts";
type EditDetails = TextMutationDetails;
type EditRenderContext = Parameters<NonNullable<ToolDefinition<EditSchema>["renderCall"]>>[2];

/** Split a validated anchor token; prepareArguments and the schema already checked it. */
function parseAnchor(value: string): Anchor;
function parseAnchor(value: string | undefined): Anchor | undefined;
function parseAnchor(value: string | undefined) {
  return value === undefined ? undefined : parseAnchorToken(value)!;
}

/** Edit parameters; anchors must carry exactly `hashLen` hash characters. */
function buildEditSchema(hashLen: number) {
  const pattern = anchorPattern(hashLen);
  const requiredAnchor = Type.String({
    pattern,
    description: "LINE#HASH of the target line.",
  });
  const optionalEnd = Type.Optional(
    Type.String({
      pattern,
      description: "Inclusive last LINE#HASH of the range; omit for one line.",
    }),
  );
  const bodyLines = Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), {
    minItems: 1,
    description: 'New lines, one per element, without CR/LF. At least one; [""] is one blank line.',
  });
  const transferFields = {
    op: Type.Union([Type.Literal("copy"), Type.Literal("move")], {
      description:
        "Reuse original lines without changing text or indentation; move also removes the source.",
    }),
    anchor: requiredAnchor,
    end: optionalEnd,
  };
  const editOpSchema = Type.Union([
    Type.Object(
      {
        op: Type.Literal("replace", { description: "Replace the cited line(s) with `body`." }),
        anchor: requiredAnchor,
        end: optionalEnd,
        body: bodyLines,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("delete", { description: "Delete the cited line(s)." }),
        anchor: requiredAnchor,
        end: optionalEnd,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([Type.Literal("insert_after"), Type.Literal("insert_before")], {
          description:
            "Insert body beside the anchor line, which is kept; do not repeat it in body.",
        }),
        anchor: requiredAnchor,
        body: bodyLines,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...transferFields,
        before: Type.String({
          pattern,
          description: "Insert captured lines before this original line.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...transferFields,
        after: Type.String({
          pattern,
          description: "Insert captured lines after this original line.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([Type.Literal("append"), Type.Literal("prepend")], {
          description: "Add body at the end or start of the file.",
        }),
        body: bodyLines,
      },
      { additionalProperties: false },
    ),
  ]);
  return Type.Object(
    {
      path: Type.String({
        minLength: 1,
        description: "Path to the file (relative or absolute)",
      }),
      edits: Type.Array(editOpSchema, {
        minItems: 1,
        description: `Operations on one snapshot. Anchors are LINE#HASH with exactly ${hashLen} hash characters, copied from the latest read, grep, edit, or replace result.`,
      }),
    },
    { additionalProperties: false },
  );
}
type EditSchema = ReturnType<typeof buildEditSchema>;

function createEditSchema(actionFusion: boolean, hashLen: number) {
  return withThenRunSchema(buildEditSchema(hashLen), "edit", actionFusion);
}
type EditParams = Static<EditSchema> & { then_run?: ThenRunInput };

type EditOpInput = Static<EditSchema>["edits"][number];

/** Report semantic argument issues; malformed shapes remain Pi's schema responsibility. */
function checkEditArguments(args: unknown, hashLen: number, report: ReportArgumentIssue): void {
  const raw = (args as { edits?: unknown } | null)?.edits;
  const edits = argumentItems(raw);
  let hashLengthRecoveryHint = " Read or grep the file for current anchors.";
  edits.forEach((op, index) => {
    const body = (op as Record<string, unknown> | null)?.body;
    if (Array.isArray(body)) {
      if (body.length === 0) {
        report(
          `edits[${index}].body`,
          (op as Record<string, unknown>).op === "replace"
            ? 'is empty; use {"op":"delete"} to remove lines, or supply the replacement lines.'
            : 'is empty; remove this edit or supply at least one line ([""] for a blank line).',
        );
      }
      body.forEach((line, lineIndex) => {
        const unwritable = typeof line === "string" ? unwritableTextError(line) : undefined;
        if (unwritable) report(`edits[${index}].body[${lineIndex}]`, unwritable.message);
      });
    }
    for (const field of EDIT_ANCHOR_FIELDS) {
      const value = (op as Record<string, unknown> | null)?.[field];
      if (typeof value !== "string") continue;
      const token = parseAnchorToken(value);
      if (token && !Number.isSafeInteger(token.line)) {
        report(
          `edits[${index}].${field}`,
          `line number in ${value} exceeds the safe integer range; copy a complete "LINE#HASH" token from the latest tool result.`,
        );
      }
      if (token && token.hash.length !== hashLen) {
        report(
          `edits[${index}].${field}`,
          `Anchor hash length mismatch: ${value} has ${token.hash.length} hash characters, but hashLen is ${hashLen}.${hashLengthRecoveryHint}`,
        );
        hashLengthRecoveryHint = "";
      }
    }
  });
}

/** Translate validated public operations into core edits, parsing numeric anchor positions. */
function toCoreEdits(ops: readonly EditOpInput[]): Edit[] {
  return ops.map((op) => {
    switch (op.op) {
      case "replace":
        return {
          op: "replace",
          start: parseAnchor(op.anchor),
          end: parseAnchor(op.end),
          body: op.body,
        };
      case "delete":
        return { op: "delete", start: parseAnchor(op.anchor), end: parseAnchor(op.end) };
      case "copy":
      case "move": {
        const source = { op: op.op, start: parseAnchor(op.anchor), end: parseAnchor(op.end) };
        return "before" in op
          ? { ...source, before: parseAnchor(op.before) }
          : { ...source, after: parseAnchor(op.after) };
      }
      case "insert_after":
      case "insert_before":
        return { op: op.op, anchor: parseAnchor(op.anchor), body: op.body };
      case "append":
      case "prepend":
        return { op: op.op, body: op.body };
    }
  });
}

/**
 * Return compact tokens for produced rows, retaining content for deletion successors.
 * Uses the applicator's final indices so mixed batches do not need a second position calculation.
 */
function formatUpdatedAnchors(
  before: string,
  newText: string,
  touched: readonly number[],
  contextLines: readonly number[],
  anchors: AnchorFormatter,
): string {
  const idxs = [...new Set(touched)].sort((a, b) => a - b);
  return formatMutationAnchors(
    splitLines(before),
    splitLines(newText),
    idxs,
    anchors,
    "Updated anchors:",
    new Set(contextLines),
  );
}

/** Call header with total/per-kind operation counts and the result's diff counts. */
function editHeader(args: EditParams, theme: Theme, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("edit "));
  t += theme.fg("accent", args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const n = edits.length;
  if (n) {
    const opCounts: Record<EditOpInput["op"] | "unknown", number> = {
      replace: 0,
      delete: 0,
      copy: 0,
      move: 0,
      insert_before: 0,
      insert_after: 0,
      append: 0,
      prepend: 0,
      unknown: 0,
    };
    // Renderers receive partial arguments; fixed buckets keep one-pass counting O(1) in space.
    for (const edit of edits) {
      const kind = edit?.op;
      if (typeof kind === "string" && Object.hasOwn(opCounts, kind)) opCounts[kind]++;
      else opCounts.unknown++;
    }
    const summary = Object.entries(opCounts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ×${count}`)
      .join(", ");
    t += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${summary}`);
  }
  if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
  return t;
}

export function makeEditOverride(
  cwd: string,
  config: HashlineEditConfig,
  fusion?: ActionFusionExecutor,
) {
  // Schema, verification, recovery, and returned anchors use the registered configuration.
  const { hashLen, shiftRadius } = config;
  const parameters = createEditSchema(fusion !== undefined, hashLen);

  return {
    name: "edit" as const,
    label: "edit",
    description:
      "Edit file lines by LINE#HASH anchors checked against the current file. Returns fresh anchors for changed lines. On anchor failure, shows current context and recovery candidates; nothing is retried automatically.",
    promptSnippet: "Edit file lines using verified anchors",
    promptGuidelines: [
      MUTATION_TOOL_GUIDELINE,
      "Batch all edits to one file in a single edit call; all its anchors are checked against one snapshot.",
      "Use copy/move for unchanged whole-line transfers; use body edits when text or indentation must change.",
      "Reuse anchors while their line number and content are unchanged; inserts and deletes shift later lines, so use the edit's Updated anchors or re-read shifted lines.",
      "On edit anchor failure, inspect the recovery candidates before retrying or re-reading.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    prepareArguments: createArgumentPreparer("edit", parameters, (args, report) =>
      checkEditArguments(args, hashLen, report),
    ),
    renderShell: "default" as const,

    renderCall(args: EditParams, theme: Theme, context: EditRenderContext) {
      return renderMutationCall(args, theme, context, editHeader);
    },

    renderResult(
      result: AgentToolResult<EditDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: EditRenderContext,
    ) {
      return renderMutationResult(
        result,
        options,
        theme,
        context,
        "Editing…",
        "Edited",
        editHeader,
      );
    },

    async execute(
      toolCallId: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<EditDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      return executeMutation<Omit<EditParams, "then_run">, EditDetails>(
        {
          tool: "edit",
          cwd,
          fusion,
          run: (mutationParams, target) =>
            runHashline(target, mutationParams.edits, hashLen, shiftRadius),
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}

function runHashline(
  target: MutationTarget,
  editOps: readonly EditOpInput[],
  hashLen: number,
  shiftRadius: number,
) {
  const anchorFormatter = createAnchorFormatter(hashLen);

  return runTextMutation(target, (currentText) => {
    const translated = toCoreEdits(editOps);

    // Recovery reports checksum candidates from nearby lines, then the whole file
    // if needed. Every failed anchor still rejects the batch; callers inspect
    // candidates and resubmit with fresh anchors.
    const result = applyEdits(currentText, translated, hashLen, shiftRadius);
    if (!result.ok) {
      throw describeEditFailure(
        result.failure,
        { currentText, anchors: anchorFormatter },
        translated.length > 1,
      );
    }

    return {
      text: result.text,
      anchors: () =>
        formatUpdatedAnchors(
          currentText,
          result.text,
          result.touchedLines,
          result.contextLines,
          anchorFormatter,
        ),
      summary: () =>
        `Edited ${target.displayPath} (${translated.length} op(s)${result.changed ? "" : ", no net change"}).`,
    };
  });
}

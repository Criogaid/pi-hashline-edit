/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors from read, grep, or edit failure diagnostics.
 * The core verifies each anchor live against
 * the current file content — no prior-read revision guard: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit. The extension requires structured `edits` arrays
 * at execution; Pi may coerce a single object before validation. Legacy
 * oldText/newText inputs fail schema validation before mutation.
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
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
  ACTION_FUSION_GUIDELINES,
  withThenRunDescription,
  withThenRunSchema,
  type ThenRunInput,
} from "./action-fusion.ts";
import { applyEdits } from "../core/apply.ts";
import { unwritableTextError } from "../core/text.ts";
import { EDIT_ANCHOR_FIELDS, type Anchor, type Edit } from "../core/types.ts";
import type { HashlineEditConfig } from "./config.ts";
import { anchorPattern, createAnchorFormatter, parseAnchorToken } from "./anchor-format.ts";
import {
  formatDiffCounts,
  renderMutationCall,
  renderMutationResult,
  type DiffCounts,
} from "./render.ts";
import { describeEditFailure } from "./failure-context.ts";
import { defaultOutputBudgets, type OutputBudgetProvider } from "./budgets.ts";
import {
  executeMutation,
  runTextMutation,
  type ActionFusionExecutor,
  type MutationTarget,
  type TextMutationDetails,
} from "./mutation-runner.ts";
import type { MutationResultDetails } from "./mutation-result.ts";
import {
  argumentItems,
  createArgumentPreparer,
  type ReportArgumentIssue,
} from "./argument-validation.ts";
type EditDetails = MutationResultDetails<TextMutationDetails>;
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
        "Copy, or move (also removes the source), whole lines whose text and indentation stay unchanged; use a body edit when either changes.",
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
        description: `Operations on one snapshot; ranges must not overlap. Insertions at one position, or at the start of a replaced or deleted range, apply in array order before it. Anchors are LINE#HASH with exactly ${hashLen} hash characters. Copy each anchor from read, grep, or edit failure diagnostics; never write a hash you have not seen there. Shell output such as sed, head, or cat has no anchors, so read or grep those lines first.`,
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

/** How to correct edit argument issues; each reason states only what is wrong. */
const EDIT_ISSUE_FIX = {
  emptyReplace: 'Use {"op":"delete"} to remove lines, or supply the replacement lines.',
  emptyBody: 'Remove this edit or supply at least one line ([""] for a blank line).',
  unsafeLine: 'Copy a complete "LINE#HASH" token from the latest tool result.',
  hashLength: "Read or grep the file for current anchors.",
} as const;

/** Report semantic argument issues; malformed shapes remain Pi's schema responsibility. */
function checkEditArguments(args: unknown, hashLen: number, report: ReportArgumentIssue): void {
  const raw = (args as { edits?: unknown } | null)?.edits;
  const edits = argumentItems(raw);
  edits.forEach((op, index) => {
    const body = (op as Record<string, unknown> | null)?.body;
    if (Array.isArray(body)) {
      if (body.length === 0) {
        report(
          `edits[${index}].body`,
          "is empty",
          (op as Record<string, unknown>).op === "replace"
            ? EDIT_ISSUE_FIX.emptyReplace
            : EDIT_ISSUE_FIX.emptyBody,
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
          "line number exceeds the safe integer range",
          EDIT_ISSUE_FIX.unsafeLine,
        );
      }
      if (token && token.hash.length !== hashLen) {
        report(
          `edits[${index}].${field}`,
          `has ${token.hash.length} hash characters; hashLen is ${hashLen}`,
          EDIT_ISSUE_FIX.hashLength,
        );
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
          anchor: parseAnchor(op.anchor),
          end: parseAnchor(op.end),
          body: op.body,
        };
      case "delete":
        return { op: "delete", anchor: parseAnchor(op.anchor), end: parseAnchor(op.end) };
      case "copy":
      case "move": {
        const source = { op: op.op, anchor: parseAnchor(op.anchor), end: parseAnchor(op.end) };
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
  budgets: OutputBudgetProvider = defaultOutputBudgets,
) {
  // Schema, verification, and recovery use the registered configuration.
  const { hashLen, shiftRadius } = config;
  const parameters = createEditSchema(fusion !== undefined, hashLen);

  return {
    name: "edit" as const,
    label: "edit",
    description: withThenRunDescription(
      "Edit whole lines using LINE#HASH anchors checked against the current file. Use replace instead when the same change repeats in several places, or when only a fragment of a long line changes.",
      fusion !== undefined,
    ),
    promptSnippet: "Edit file lines using verified anchors",
    promptGuidelines: [
      "Batch all edits to one file into a single edit call.",
      "After edit or replace, get fresh anchors with read or grep before citing any line it changed. If it added or removed lines, also refresh anchors below the earliest affected line; anchors above it remain valid. If the affected positions are unknown, read or grep the lines you intend to cite.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    prepareArguments: createArgumentPreparer(
      "edit",
      parameters,
      (args, report) => checkEditArguments(args, hashLen, report),
      budgets,
    ),
    renderShell: "default" as const,

    renderCall(args: EditParams, theme: Theme, context: EditRenderContext) {
      return renderMutationCall(args, theme, context, editHeader);
    },

    renderResult(
      result: Parameters<typeof renderMutationResult>[0],
      options: ToolRenderResultOptions,
      theme: Theme,
      context: EditRenderContext,
    ) {
      return renderMutationResult(result, options, theme, context, "Editing…", editHeader, "edit");
    },

    async execute(
      toolCallId: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<EditDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      return executeMutation<EditParams, TextMutationDetails, "edit">(
        {
          tool: "edit",
          cwd,
          fusion,
          budgets,
          run: (mutationParams, target) =>
            runEdit(target, mutationParams.edits, hashLen, shiftRadius),
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}

function runEdit(
  target: MutationTarget,
  editOps: readonly EditOpInput[],
  hashLen: number,
  shiftRadius: number,
) {
  const anchorFormatter = createAnchorFormatter(hashLen);

  return runTextMutation<"edit">(target, (currentText) => {
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
        target.budget,
      );
    }

    return {
      text: result.text,
      facts: {},
    };
  });
}

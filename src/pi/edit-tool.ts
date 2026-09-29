/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors copied from read / grep / replace output
 * (or from a prior edit's "Updated anchors"). The core verifies each anchor live against
 * the current file content — no snapshot, no global stale check: a cited line
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
  truncateHead,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { applyEdits } from "../core/apply.ts";
import { splitLines } from "../core/lines.ts";
import { unwritableTextReason } from "../core/text.ts";
import { invalidArgument } from "./error-text.ts";
import type { Anchor, ApplyFailure, Edit } from "../core/types.ts";
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
import {
  formatAmbiguousCandidateNeighborhoods,
  selectAmbiguousCandidates,
} from "./failure-context.ts";
import { formatKiB, MAX_BLOCK_BYTES, MAX_RECOVERY_CANDIDATE_BYTES } from "./budgets.ts";
import { formatMutationAnchors } from "./mutation-result.ts";
import {
  executeMutation,
  runTextMutation,
  type ActionFusionExecutor,
  type MutationTarget,
  type TextMutationDetails,
} from "./mutation-runner.ts";
type EditDetails = TextMutationDetails;
type EditRenderContext = Parameters<NonNullable<ToolDefinition<EditSchema>["renderCall"]>>[2];

/** Keep independent byte budgets for failure details and input-anchor checks. */
function boundDiagnostic(message: string, notice: string): string {
  const bounded = truncateHead(message, { maxBytes: MAX_BLOCK_BYTES - Buffer.byteLength(notice) });
  return bounded.content + (bounded.truncated ? notice : "");
}

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
    description: "New lines, one per element, without CR/LF.",
  });
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
  return withThenRunSchema(
    buildEditSchema(hashLen),
    "Command to run after the edit succeeds; failure does not roll back the edit.",
    actionFusion,
  );
}
type EditParams = Static<EditSchema> & { then_run?: ThenRunInput };

type EditOpInput = Static<EditSchema>["edits"][number];

/**
 * Checks the schema cannot express, run before Pi's schema validation. Rejects body
 * lines that cannot be written as UTF-8, anchor line numbers beyond the safe-integer
 * range, and names anchors whose hash length differs from `hashLen` (the schema would
 * report only a bare pattern mismatch). Malformed shapes are left to the schema.
 * Arguments are never changed.
 */
function checkEditArguments(args: unknown, hashLen: number): void {
  const edits = (args as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(edits)) return;
  const mismatches: string[] = [];
  edits.forEach((op, index) => {
    const body = (op as Record<string, unknown> | null)?.body;
    if (Array.isArray(body)) {
      body.forEach((line, lineIndex) => {
        const reason = typeof line === "string" ? unwritableTextReason(line) : undefined;
        if (reason) throw invalidArgument(`edits[${index}].body[${lineIndex}]`, reason);
      });
    }
    for (const field of ["anchor", "end"] as const) {
      const value = (op as Record<string, unknown> | null)?.[field];
      if (typeof value !== "string") continue;
      const token = parseAnchorToken(value);
      if (token && !Number.isSafeInteger(token.line)) {
        throw invalidArgument(
          `edits[${index}].${field}`,
          `line number in ${value} exceeds the safe integer range; copy a complete "LINE#HASH" token from the latest tool result.`,
        );
      }
      if (token && token.hash.length !== hashLen) {
        mismatches.push(
          `edits[${index}].${field} ${value} has ${token.hash.length} hash characters`,
        );
      }
    }
  });
  if (mismatches.length) {
    throw new Error(
      `Anchor hash length mismatch: ${mismatches.join("; ")}, but hashLen is ${hashLen}. Anchors from a different hashLen setting cannot be verified; read or grep the file for current anchors.`,
    );
  }
}

/** Format failure mappings and complete unique-candidate rows within the detail budget. */
function formatFailureDetails(
  failure: ApplyFailure,
  snapshot: Readonly<{ currentText: string; anchors: AnchorFormatter }>,
  candidateLines: ReadonlySet<number>,
): string {
  if (failure.kind !== "anchor") return failure.message;

  const lines: string[] = [];
  const currentLines = splitLines(snapshot.currentText);
  const shownCandidates = new Set(candidateLines);
  let found = 0;
  let ambiguous = 0;
  let none = 0;
  for (const f of failure.failures) {
    if (f.recovery.kind === "found") found++;
    else if (f.recovery.kind === "ambiguous") ambiguous++;
    else none++;
    const where = `op #${f.opIndex} ${f.op} ${f.which} (line ${f.cited.line})`;
    const search =
      f.recovery.kind === "none"
        ? ""
        : f.recovery.scope === "local"
          ? "Search: local; matches outside the window were not checked."
          : "Search: full file.";
    switch (f.recovery.kind) {
      case "found": {
        const content = currentLines[f.recovery.newLine - 1];
        const candidate = snapshot.anchors.reference(f.recovery.newLine, f.recovery.newHash);
        const row =
          content === undefined ? candidate : snapshot.anchors.row(f.recovery.newLine, content);
        let detail = `• ${where}: checksum-matching candidate ${candidate}. ${search}`;
        if (!shownCandidates.has(f.recovery.newLine)) {
          if (
            content !== undefined &&
            Buffer.byteLength(row, "utf8") <= MAX_RECOVERY_CANDIDATE_BYTES
          ) {
            detail += `\n${row}`;
            shownCandidates.add(f.recovery.newLine);
          } else {
            detail += ` Candidate content exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}.`;
          }
        }
        lines.push(detail);
        break;
      }
      case "ambiguous": {
        const candidates = selectAmbiguousCandidates(f.recovery.candidates);
        const list = candidates
          .map((candidate) => `"${snapshot.anchors.reference(candidate.line, candidate.hash)}"`)
          .join(" / ");
        const omitted = f.recovery.candidates.length - candidates.length;
        const more = omitted ? ` (${omitted} more candidates omitted)` : "";
        lines.push(`• ${where}: ambiguous checksum matches: ${list}${more}. ${search}`);
        break;
      }
      case "none": {
        const row =
          f.current === null ? null : snapshot.anchors.row(f.cited.line, f.current.content);
        if (row !== null && Buffer.byteLength(row, "utf8") <= MAX_RECOVERY_CANDIDATE_BYTES) {
          lines.push(
            `• ${where}: no checksum-matching candidate found. Current cited line (validation snapshot; observation only):\n${row}\nConfirm this is the intended target before reusing its anchor directly; retries revalidate.`,
          );
        } else {
          lines.push(
            `• ${where}: no checksum-matching candidate found. Use read or grep to inspect the current file before retrying.` +
              (f.current === null
                ? " Cited line is out of range."
                : ` Current row exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}.`),
          );
        }
        break;
      }
    }
  }
  const parts: string[] = [];
  if (found) parts.push(`${found} shifted`);
  if (ambiguous) parts.push(`${ambiguous} ambiguous`);
  if (none) parts.push(`${none} unresolved`);
  const message = [
    `Anchor mismatch: ${parts.join(", ")}.`,
    "No changes written by this edit batch.",
    ...lines,
  ].join("\n");
  return boundDiagnostic(
    message,
    `\nDiagnostic output truncated at ${formatKiB(MAX_BLOCK_BYTES)}.`,
  );
}

function formatAnchorChecks(failure: ApplyFailure, anchors: AnchorFormatter): string {
  const rows = failure.checks.map(
    (check) =>
      `op ${check.opIndex} / ${check.which} / ${anchors.reference(check.cited.line, check.cited.hash)} / ${check.status}`,
  );
  const message = [
    "Input-anchor checks (this snapshot):",
    ...rows,
    "Anchor checks only; retries revalidate.",
  ].join("\n");
  return boundDiagnostic(
    message,
    `\nAnchor-check output truncated at ${formatKiB(MAX_BLOCK_BYTES)}; omitted entries are not implied matched.`,
  );
}

/** Keep validation status and observation context visible even when failure details are truncated. */
function formatFailure(
  failure: ApplyFailure,
  snapshot: Readonly<{ currentText: string; anchors: AnchorFormatter }>,
  isBatch: boolean,
): string {
  const candidateNeighborhoods =
    failure.kind === "anchor"
      ? formatAmbiguousCandidateNeighborhoods(
          snapshot.currentText,
          failure.failures,
          snapshot.anchors,
        )
      : { text: "", shownLines: new Set<number>() };
  const guidance =
    failure.kind === "anchor"
      ? "\nCheck the intended target before retrying; use read or grep for omitted or additional context."
      : "";
  const anchorChecks =
    isBatch && failure.checks.length > 0
      ? `\n${formatAnchorChecks(failure, snapshot.anchors)}`
      : "";
  return `${formatFailureDetails(failure, snapshot, candidateNeighborhoods.shownLines)}${anchorChecks}${candidateNeighborhoods.text}${guidance}`;
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
 * Return compact tokens for changed caller-supplied rows, retaining content for deletion successors.
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

/** Call-header line: `edit path — N ops: op`, plus `+N -N` once the result's diff counts are known. */
function editHeader(args: EditParams, theme: Theme, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("edit "));
  t += theme.fg("accent", args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const n = edits.length;
  if (n) {
    const kind = typeof edits[0]?.op === "string" ? edits[0].op : "unknown";
    t += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${kind}`);
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
      "Batch related edits to one file in a single edit call; all its anchors are checked against one snapshot.",
      "Reuse anchors while their line number and content are unchanged; inserts and deletes shift later lines, so use the edit's Updated anchors or re-read shifted lines.",
      "On edit anchor failure, inspect the recovery candidates before retrying or re-reading.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    prepareArguments(args: unknown): EditParams {
      checkEditArguments(args, hashLen);
      return args as EditParams;
    },
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
      ctx: ExtensionContext,
    ) {
      return executeMutation<Omit<EditParams, "then_run">, EditDetails>(
        {
          cwd,
          fusion,
          reportsAnchors: true,
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

  return runTextMutation("edit", target, (currentText) => {
    const translated = toCoreEdits(editOps);

    // Recovery reports checksum candidates from nearby lines, then the whole file
    // if needed. Every failed anchor still rejects the batch; callers inspect
    // candidates and resubmit with fresh anchors.
    const result = applyEdits(currentText, translated, hashLen, shiftRadius);
    if (!result.ok) {
      throw new Error(
        formatFailure(
          result.failure,
          { currentText, anchors: anchorFormatter },
          translated.length > 1,
        ),
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

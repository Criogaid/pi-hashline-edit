/**
 * Bounded edit failure facts for the error record: anchor failures with their
 * recovery candidates or observed rows, the batch's matched anchors, and
 * ambiguous-candidate neighborhoods.
 *
 * Each fact has one owner. A failure entry states what was cited and what the
 * search found; a shifted candidate's anchor is stated once, beside its
 * `content`; `matched` lists only the anchors that passed, so a mismatch
 * appears once, in `failures`; a row shown in a neighborhood is not repeated
 * in a failure entry. The `observed` and neighborhood rows are observations,
 * not verified targets. Every list has its own byte budget and an explicit
 * omission count. The recovery instruction is the record's `next` (tool-error.ts).
 *
 * @module pi-hashline-edit/pi
 */

import { type AnchorFormatter, displayCarriageReturns } from "./anchor-format.ts";
import { splitLines } from "../core/lines.ts";
import type { Anchor, AnchorFailure, ApplyFailure } from "../core/types.ts";
import { mergeRanges } from "../core/ranges.ts";
import { HashlineError, type ErrorFacts } from "../core/errors.ts";
import { formatKiB, MAX_BLOCK_BYTES, MAX_RECOVERY_CANDIDATE_BYTES } from "./budgets.ts";
import { boundedFacts } from "./tool-error.ts";

const CONTEXT_RADIUS = 3;
const MAX_AMBIGUOUS_CANDIDATES = 8;

type Snapshot = Readonly<{ currentText: string; anchors: AnchorFormatter }>;

/** Select the shared candidate prefix for detail lists and observation neighborhoods. */
export function selectAmbiguousCandidates(candidates: readonly Anchor[]): readonly Anchor[] {
  return candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
}

type ContextRow = { line: number; text: string };

function collectContextRows(
  lines: readonly string[],
  centers: readonly number[],
  anchors: AnchorFormatter,
  candidateLines: ReadonlySet<number>,
) {
  const windows = mergeRanges(
    centers.map((center) => {
      const line = Math.min(lines.length, Math.max(1, center));
      return [
        Math.max(1, line - CONTEXT_RADIUS),
        Math.min(lines.length, line + CONTEXT_RADIUS) + 1,
      ];
    }),
  );
  const total = windows.reduce((sum, [start, end]) => sum + end - start, 0);
  const rows: ContextRow[] = [];
  let bytes = 0;

  for (const [start, end] of windows) {
    for (let line = start; line < end; line++) {
      const text = anchors.row(line, lines[line - 1]);
      const rowBytes = Buffer.byteLength(text, "utf8");
      // Neighborhoods must not bypass the standalone candidate's complete-row limit.
      if (candidateLines.has(line) && rowBytes > MAX_RECOVERY_CANDIDATE_BYTES) continue;
      if (bytes + rowBytes + 1 > MAX_BLOCK_BYTES) continue;
      rows.push({ line, text });
      bytes += rowBytes + 1;
    }
  }
  return { rows, omitted: total - rows.length };
}

/** Group shown rows into contiguous neighborhoods; gaps mark omitted rows. */
function groupContextRows(rows: readonly ContextRow[]) {
  const groups: { lines: string; rows: string[] }[] = [];
  let previous: ContextRow | undefined;
  let first = 0;
  for (const row of rows) {
    if (!previous || row.line !== previous.line + 1) {
      groups.push({ lines: "", rows: [] });
      first = row.line;
    }
    const group = groups[groups.length - 1];
    group.rows.push(row.text);
    group.lines = `${first}-${row.line}`;
    previous = row;
  }
  return groups;
}

/**
 * Observation rows (±3) around listed ambiguous candidates, lowest lines first,
 * and the lines actually shown so failure entries do not repeat them.
 * @internal Performs no I/O.
 */
export function ambiguousCandidateNeighborhoods(
  currentText: string,
  failures: readonly AnchorFailure[],
  anchors: AnchorFormatter,
): { facts: ErrorFacts; shownLines: ReadonlySet<number> } {
  const centers = failures.flatMap((failure) =>
    failure.recovery.kind === "ambiguous"
      ? selectAmbiguousCandidates(failure.recovery.candidates).map((candidate) => candidate.line)
      : [],
  );
  if (centers.length === 0) return { facts: {}, shownLines: new Set() };

  const candidateLines = new Set(centers);
  for (const failure of failures) {
    if (failure.recovery.kind === "found") candidateLines.add(failure.recovery.newLine);
  }
  const { rows, omitted } = collectContextRows(
    splitLines(currentText),
    centers,
    anchors,
    candidateLines,
  );
  return {
    facts: {
      candidateNeighborhoods: groupContextRows(rows),
      ...(omitted ? { omittedNeighborhoodRows: omitted } : {}),
    },
    shownLines: new Set(rows.map((row) => row.line)),
  };
}

const RESULT = { found: "shifted", ambiguous: "ambiguous", none: "unresolved" } as const;
const ROW_TOO_LARGE = `row exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}`;

/** One failure entry: what was cited, then what the search found or what the cited line holds. */
function failureEntry(
  f: AnchorFailure,
  snapshot: Snapshot,
  currentLines: readonly string[],
  shownLines: Set<number>,
): ErrorFacts {
  const entry: Record<string, unknown> = {
    field: `edits[${f.opIndex}].${f.which}`,
    op: f.op,
    cited: snapshot.anchors.reference(f.cited.line, f.cited.hash),
    result: RESULT[f.recovery.kind],
  };
  if (f.recovery.kind !== "none")
    entry.search = f.recovery.scope === "local" ? "local window" : "full file";
  switch (f.recovery.kind) {
    case "found": {
      const { newLine, newHash } = f.recovery;
      entry.candidate = snapshot.anchors.reference(newLine, newHash);
      if (shownLines.has(newLine)) break;
      const content = currentLines[newLine - 1];
      // The row budget matches the neighborhoods'; the anchor itself is already `candidate`.
      if (
        content !== undefined &&
        Buffer.byteLength(snapshot.anchors.row(newLine, content), "utf8") <=
          MAX_RECOVERY_CANDIDATE_BYTES
      ) {
        entry.content = displayCarriageReturns(content);
        shownLines.add(newLine);
      } else {
        entry.contentOmitted = ROW_TOO_LARGE;
      }
      break;
    }
    case "ambiguous": {
      const candidates = selectAmbiguousCandidates(f.recovery.candidates);
      entry.candidates = candidates.map((candidate) =>
        snapshot.anchors.reference(candidate.line, candidate.hash),
      );
      const omitted = f.recovery.candidates.length - candidates.length;
      if (omitted) entry.omittedCandidates = omitted;
      break;
    }
    case "none": {
      const row = f.current === null ? null : snapshot.anchors.row(f.cited.line, f.current.content);
      if (row === null) entry.observedOmitted = "cited line is out of range";
      else if (Buffer.byteLength(row, "utf8") <= MAX_RECOVERY_CANDIDATE_BYTES) entry.observed = row;
      else entry.observedOmitted = ROW_TOO_LARGE;
      break;
    }
  }
  return entry;
}

function anchorMismatchMessage(failures: readonly AnchorFailure[]): string {
  const counts = new Map<string, number>();
  for (const f of failures) {
    const result = RESULT[f.recovery.kind];
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  const parts = Object.values(RESULT)
    .filter((result) => counts.has(result))
    .map((result) => `${counts.get(result)} ${result}`);
  return `Anchors did not match: ${parts.join(", ")}.`;
}

/**
 * The batch's anchors whose checksum matched, by field. An anchor absent from
 * both `matched` and `failures` is counted as omitted, never implied matched.
 */
function matchedAnchorFacts(failure: ApplyFailure): ErrorFacts {
  const { kept, omitted } = boundedFacts(
    failure.checks
      .filter((check) => check.status === "matched")
      .map((check) => `edits[${check.opIndex}].${check.which}`),
    MAX_BLOCK_BYTES,
  );
  return kept.length || omitted
    ? { matched: kept, ...(omitted ? { omittedMatched: omitted } : {}) }
    : {};
}

/** Classify a rejected edit batch with its bounded facts. */
export function describeEditFailure(
  failure: ApplyFailure,
  snapshot: Snapshot,
  isBatch: boolean,
): HashlineError {
  const matched = isBatch ? matchedAnchorFacts(failure) : {};
  if (failure.kind === "range")
    return new HashlineError(failure.code, failure.message, { facts: matched });

  const neighborhoods = ambiguousCandidateNeighborhoods(
    snapshot.currentText,
    failure.failures,
    snapshot.anchors,
  );
  const currentLines = splitLines(snapshot.currentText);
  const shownLines = new Set(neighborhoods.shownLines);
  const { kept, omitted } = boundedFacts(
    failure.failures.map((f) => failureEntry(f, snapshot, currentLines, shownLines)),
    MAX_BLOCK_BYTES,
  );
  return new HashlineError("ANCHOR_MISMATCH", anchorMismatchMessage(failure.failures), {
    facts: {
      failures: kept,
      ...(omitted ? { omittedFailures: omitted } : {}),
      ...matched,
      ...neighborhoods.facts,
    },
  });
}

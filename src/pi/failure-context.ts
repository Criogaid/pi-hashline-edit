/**
 * Bounded edit failure facts for the error record: anchor failures with their
 * recovery candidates or observed rows, and ambiguous-candidate neighborhoods.
 *
 * A failure entry states what was cited and what the search found; a shifted
 * candidate's anchor is stated once, beside its `content`. The `observed` and
 * neighborhood rows are observations, not verified targets. Every list has its
 * own byte budget and an explicit omission count. The recovery instruction is
 * the report's `next`, derived from the code in report-schema.ts.
 *
 * @module pi-hashline-edit/pi
 */

import { type AnchorFormatter, displayCarriageReturns } from "./anchor-format.ts";
import { splitLines } from "../core/lines.ts";
import type { Anchor, AnchorFailure } from "../core/types.ts";
import { mergeRanges } from "../core/ranges.ts";
import { HashlineError } from "../core/errors.ts";
import { formatByteSize, type OutputBudgets } from "./budgets.ts";
import type { AnchorFailureFact, ErrorFacts } from "./report-schema.ts";

type MismatchFacts = ErrorFacts<"ANCHOR_MISMATCH">;

const CONTEXT_RADIUS = 3;
const MAX_AMBIGUOUS_CANDIDATES = 8;

type Snapshot = Readonly<{ currentText: string; anchors: AnchorFormatter }>;

/** Select the shared candidate prefix for detail lists and observation neighborhoods. */
function selectAmbiguousCandidates(candidates: readonly Anchor[]): readonly Anchor[] {
  return candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
}

type ContextRow = { line: number; text: string };

function collectContextRows(
  lines: readonly string[],
  centers: readonly number[],
  anchors: AnchorFormatter,
  candidateLines: ReadonlySet<number>,
  budget: OutputBudgets,
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
      if (candidateLines.has(line) && rowBytes > budget.fieldBytes) continue;
      if (bytes + rowBytes + 1 > budget.blockBytes) continue;
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

/** Observation rows around listed ambiguous candidates, lowest lines first. */
export function ambiguousCandidateNeighborhoods(
  currentText: string,
  failures: readonly AnchorFailure[],
  anchors: AnchorFormatter,
  budget: OutputBudgets,
): Pick<MismatchFacts, "candidateNeighborhoods" | "omittedNeighborhoodRows"> {
  const centers = failures.flatMap((failure) =>
    failure.recovery.kind === "ambiguous"
      ? selectAmbiguousCandidates(failure.recovery.candidates).map((candidate) => candidate.line)
      : [],
  );
  if (centers.length === 0) return {};

  const candidateLines = new Set(centers);
  for (const failure of failures) {
    if (failure.recovery.kind === "found") candidateLines.add(failure.recovery.newLine);
  }
  const { rows, omitted } = collectContextRows(
    splitLines(currentText),
    centers,
    anchors,
    candidateLines,
    budget,
  );
  return {
    candidateNeighborhoods: groupContextRows(rows),
    ...(omitted ? { omittedNeighborhoodRows: omitted } : {}),
  };
}

const RESULT = { found: "shifted", ambiguous: "ambiguous", none: "unresolved" } as const;

/** One failure entry: what was cited, then what the search found or what the cited line holds. */
function failureEntry(
  f: AnchorFailure,
  anchors: AnchorFormatter,
  currentLines: readonly string[],
  budget: OutputBudgets,
): AnchorFailureFact {
  const rowTooLarge = `row exceeds ${formatByteSize(budget.fieldBytes)}`;
  const entry: { -readonly [K in keyof AnchorFailureFact]: AnchorFailureFact[K] } = {
    field: `edits[${f.opIndex}].${f.which}`,
    action: f.op,
    cited: anchors.reference(f.cited.line, f.cited.hash),
    result: RESULT[f.recovery.kind],
  };
  switch (f.recovery.kind) {
    case "found": {
      const { newLine, newHash } = f.recovery;
      entry.candidate = anchors.reference(newLine, newHash);
      const content = currentLines[newLine - 1];
      // The row budget matches the neighborhoods'; the anchor itself is already `candidate`.
      if (Buffer.byteLength(anchors.row(newLine, content), "utf8") <= budget.fieldBytes) {
        entry.content = displayCarriageReturns(content);
      } else {
        entry.notShown = rowTooLarge;
      }
      break;
    }
    case "ambiguous": {
      const candidates = selectAmbiguousCandidates(f.recovery.candidates);
      entry.candidates = candidates.map((candidate) =>
        anchors.reference(candidate.line, candidate.hash),
      );
      const omitted = f.recovery.candidates.length - candidates.length;
      if (omitted) entry.omittedCandidates = omitted;
      break;
    }
    case "none": {
      const content = currentLines[f.cited.line - 1];
      if (content === undefined) {
        entry.notShown = "cited line is out of range";
        break;
      }
      const row = anchors.row(f.cited.line, content);
      if (Buffer.byteLength(row, "utf8") <= budget.fieldBytes) entry.observed = row;
      else entry.notShown = rowTooLarge;
      break;
    }
  }
  return entry;
}

/** Classify a batch's anchor failures with their bounded facts. */
export function describeEditFailure(
  failures: readonly AnchorFailure[],
  snapshot: Snapshot,
  budget: OutputBudgets,
): HashlineError<"ANCHOR_MISMATCH"> {
  const currentLines = splitLines(snapshot.currentText);
  // Leading entries whose compact JSON fits the block; whole entries are omitted, never cut.
  const kept: AnchorFailureFact[] = [];
  let bytes = 0;
  for (const failure of failures) {
    const entry = failureEntry(failure, snapshot.anchors, currentLines, budget);
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > budget.blockBytes) break;
    kept.push(entry);
  }
  const omitted = failures.length - kept.length;
  return new HashlineError("ANCHOR_MISMATCH", "Anchors did not match the current file.", {
    facts: {
      failures: kept,
      ...(omitted ? { omittedFailures: omitted } : {}),
      ...ambiguousCandidateNeighborhoods(snapshot.currentText, failures, snapshot.anchors, budget),
    },
  });
}

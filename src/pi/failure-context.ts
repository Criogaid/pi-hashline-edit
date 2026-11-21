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

/** Select the shared candidate prefix for detail lists and observation neighborhoods. */
function selectAmbiguousCandidates(candidates: readonly Anchor[]): readonly Anchor[] {
  return candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
}

/** Keep complete rows in contiguous neighborhoods, counting compact JSON bytes. */
function collectNeighborhoods(
  lines: readonly string[],
  centers: readonly number[],
  anchors: AnchorFormatter,
  candidateLines: ReadonlySet<number>,
  budget: OutputBudgets,
) {
  const windows = mergeRanges(
    centers.map((line) => [
      Math.max(1, line - CONTEXT_RADIUS),
      Math.min(lines.length, line + CONTEXT_RADIUS) + 1,
    ]),
  );
  const total = windows.reduce((sum, [start, end]) => sum + end - start, 0);
  const groups: { lines: string; rows: string[] }[] = [];
  let first = 0;
  let previous = -1;
  let shown = 0;
  let bytes = Buffer.byteLength("[]");

  for (const [start, end] of windows) {
    for (let line = start; line < end; line++) {
      const text = anchors.row(line, lines[line - 1]);
      // Neighborhoods must not bypass the standalone candidate's complete-row limit.
      if (candidateLines.has(line) && Buffer.byteLength(text) > budget.fieldBytes) continue;
      const group = line === previous + 1 ? groups.at(-1) : undefined;
      const range = `${group ? first : line}-${line}`;
      const overhead = group
        ? 1 + range.length - group.lines.length // Row comma and change in the ASCII range.
        : Number(groups.length > 0) + Buffer.byteLength(JSON.stringify({ lines: range, rows: [] }));
      const added = Buffer.byteLength(JSON.stringify(text)) + overhead;
      if (bytes + added > budget.blockBytes) continue;
      if (group) {
        group.rows.push(text);
        group.lines = range;
      } else {
        groups.push({ lines: range, rows: [text] });
        first = line;
      }
      previous = line;
      shown++;
      bytes += added;
    }
  }
  return { groups, omitted: total - shown };
}

/** Observation rows around listed ambiguous candidates, lowest lines first. */
function ambiguousCandidateNeighborhoods(
  currentLines: readonly string[],
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
  const { groups, omitted } = collectNeighborhoods(
    currentLines,
    centers,
    anchors,
    candidateLines,
    budget,
  );
  return {
    candidateNeighborhoods: groups,
    ...(omitted ? { omittedNeighborhoodRows: omitted } : {}),
  };
}

/** One failure entry: what was cited, then what the search found or what the cited line holds. */
function failureEntry(
  f: AnchorFailure,
  anchors: AnchorFormatter,
  currentLines: readonly string[],
  budget: OutputBudgets,
): AnchorFailureFact {
  const rowTooLarge = `row exceeds ${formatByteSize(budget.fieldBytes)}`;
  const cited = {
    field: `steps[${f.opIndex}].${f.which}`,
    action: f.op,
    cited: anchors.reference(f.cited.line, f.cited.hash),
  };
  switch (f.recovery.kind) {
    case "found": {
      const { newLine, newHash } = f.recovery;
      const shifted = {
        ...cited,
        result: "shifted" as const,
        candidate: anchors.reference(newLine, newHash),
      };
      const content = currentLines[newLine - 1];
      // The row budget matches the neighborhoods'; the anchor itself is already `candidate`.
      return Buffer.byteLength(anchors.row(newLine, content), "utf8") <= budget.fieldBytes
        ? { ...shifted, content: displayCarriageReturns(content) }
        : { ...shifted, notShown: rowTooLarge };
    }
    case "ambiguous": {
      const candidates = selectAmbiguousCandidates(f.recovery.candidates);
      const omitted = f.recovery.candidates.length - candidates.length;
      return {
        ...cited,
        result: "ambiguous",
        candidates: candidates.map((candidate) =>
          anchors.reference(candidate.line, candidate.hash),
        ),
        ...(omitted ? { omittedCandidates: omitted } : {}),
      };
    }
    case "none": {
      const unresolved = { ...cited, result: "unresolved" as const };
      const content = currentLines[f.cited.line - 1];
      if (content === undefined) return { ...unresolved, notShown: "cited line is out of range" };
      const row = anchors.row(f.cited.line, content);
      return Buffer.byteLength(row, "utf8") <= budget.fieldBytes
        ? { ...unresolved, observed: row }
        : { ...unresolved, notShown: rowTooLarge };
    }
  }
}

/** Classify a batch's anchor failures; each entry's rows fit the field budget, and the report layer bounds the list. */
export function describeEditFailure(
  currentText: string,
  failures: readonly AnchorFailure[],
  anchors: AnchorFormatter,
  budget: OutputBudgets,
): HashlineError<"ANCHOR_MISMATCH"> {
  const currentLines = splitLines(currentText);
  return new HashlineError("ANCHOR_MISMATCH", "Anchors did not match the current file.", {
    facts: {
      failures: failures.map((failure) => failureEntry(failure, anchors, currentLines, budget)),
      ...ambiguousCandidateNeighborhoods(currentLines, failures, anchors, budget),
    },
  });
}

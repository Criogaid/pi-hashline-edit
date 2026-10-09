/**
 * Bounded anchor-failure diagnostics for edit: failure details with recovery
 * candidates, input-anchor checks, and ambiguous-candidate neighborhoods.
 *
 * Each statement has one owner. Failure details state facts, including that
 * nothing was written; the input-anchor table header qualifies its statuses;
 * observation labels stay with the rows they qualify. The recovery instruction
 * follows every bounded block once, so no truncation removes it.
 *
 * @module pi-hashline-edit/pi
 */

import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { AnchorFormatter } from "./anchor-format.ts";
import { splitLines } from "../core/lines.ts";
import type { Anchor, AnchorFailure, ApplyFailure } from "../core/types.ts";
import { mergeRanges } from "../core/ranges.ts";
import { formatKiB, MAX_BLOCK_BYTES, MAX_RECOVERY_CANDIDATE_BYTES } from "./budgets.ts";

const CONTEXT_RADIUS = 3;
const MAX_AMBIGUOUS_CANDIDATES = 8;

/** Publication fact for every rejected edit batch. */
const NO_CHANGES_WRITTEN = "No changes written by this edit batch.";
/** The single recovery instruction for anchor failures; details and checks state facts only. */
const ANCHOR_RECOVERY_GUIDANCE =
  "Before reusing a candidate or observed anchor, confirm it is the intended target; use read or grep for omitted rows, out-of-range lines, or more context. Retries verify every anchor again.";

/** Select the shared candidate prefix for detail lists and observation neighborhoods. */
export function selectAmbiguousCandidates(candidates: readonly Anchor[]): readonly Anchor[] {
  return candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
}

type Interval = { lo: number; hi: number };
type ContextRow = { line: number; text: string };

function shownIntervals(rows: readonly ContextRow[]): Interval[] {
  const intervals: Interval[] = [];
  for (const row of rows) {
    const previous = intervals.at(-1);
    if (previous && row.line === previous.hi + 1) previous.hi = row.line;
    else intervals.push({ lo: row.line, hi: row.line });
  }
  return intervals;
}

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
  const omissions = new Set<"byte limit" | "candidate row limit">();

  for (const [start, end] of windows) {
    for (let line = start; line < end; line++) {
      const content = lines[line - 1];
      const text = anchors.row(line, content);
      const rowBytes = Buffer.byteLength(text, "utf8");
      // Neighborhoods must not bypass the standalone candidate's complete-row limit.
      if (candidateLines.has(line) && rowBytes > MAX_RECOVERY_CANDIDATE_BYTES) {
        omissions.add("candidate row limit");
        continue;
      }
      if (bytes + rowBytes + 1 > MAX_BLOCK_BYTES) {
        omissions.add("byte limit");
        continue;
      }
      rows.push({ line, text });
      bytes += rowBytes + 1;
    }
  }
  return { rows, total, truncatedBy: [...omissions].join(" and ") || undefined };
}

function formatContextRows(rows: readonly ContextRow[]): string[] {
  const body: string[] = [];
  let index = 0;
  for (const interval of shownIntervals(rows)) {
    body.push(`@@ candidate-neighborhood lines ${interval.lo}-${interval.hi} @@`);
    while (index < rows.length && rows[index].line <= interval.hi) body.push(rows[index++].text);
  }
  return body;
}

/**
 * Format observation rows around listed ambiguous candidates and report rows actually shown.
 * @internal Performs no I/O; the edit diagnostic uses shownLines to avoid repeating content.
 */
export function formatAmbiguousCandidateNeighborhoods(
  currentText: string,
  failures: readonly AnchorFailure[],
  anchors: AnchorFormatter,
): { text: string; shownLines: ReadonlySet<number> } {
  const centers = failures.flatMap((failure) =>
    failure.recovery.kind === "ambiguous"
      ? selectAmbiguousCandidates(failure.recovery.candidates).map((candidate) => candidate.line)
      : [],
  );
  if (centers.length === 0) return { text: "", shownLines: new Set() };

  const lines = splitLines(currentText);
  const candidateLines = new Set(centers);
  for (const failure of failures) {
    if (failure.recovery.kind === "found") candidateLines.add(failure.recovery.newLine);
  }
  const { rows, total, truncatedBy } = collectContextRows(lines, centers, anchors, candidateLines);
  const body = [`Ambiguous-candidate neighborhoods (+/-${CONTEXT_RADIUS}; observation only):`];
  if (rows.length === 0) {
    body.push("No complete neighborhood row fits the limits.");
  } else {
    body.push(...formatContextRows(rows));
  }
  if (truncatedBy) {
    body.push(
      `Candidate-neighborhood rows: ${rows.length}/${total}; ${total - rows.length} omitted.`,
    );
    body.push(
      `Candidate neighborhoods truncated: ${truncatedBy} (${formatKiB(MAX_BLOCK_BYTES)}; candidate row ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}; lowest lines first).`,
    );
  }
  return { text: `\n${body.join("\n")}`, shownLines: new Set(rows.map((row) => row.line)) };
}

/** Keep independent byte budgets for failure details and input-anchor checks. */
function boundDiagnostic(message: string, notice: string): string {
  const bounded = truncateHead(message, { maxBytes: MAX_BLOCK_BYTES - Buffer.byteLength(notice) });
  return bounded.content + (bounded.truncated ? notice : "");
}
/** Describe anchor failures as facts: the outcome headline, then candidates or observed rows per failure. */
function describeAnchorFailures(
  failures: readonly AnchorFailure[],
  snapshot: Readonly<{ currentText: string; anchors: AnchorFormatter }>,
  candidateLines: ReadonlySet<number>,
): string[] {
  const lines: string[] = [];
  const currentLines = splitLines(snapshot.currentText);
  const shownCandidates = new Set(candidateLines);
  let found = 0;
  let ambiguous = 0;
  let none = 0;
  for (const f of failures) {
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
        const observation =
          row === null
            ? " Cited line is out of range."
            : Buffer.byteLength(row, "utf8") <= MAX_RECOVERY_CANDIDATE_BYTES
              ? ` Current cited line (observation only):\n${row}`
              : ` Current row exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}.`;
        lines.push(`• ${where}: no checksum-matching candidate found.${observation}`);
        break;
      }
    }
  }
  const parts: string[] = [];
  if (found) parts.push(`${found} shifted`);
  if (ambiguous) parts.push(`${ambiguous} ambiguous`);
  if (none) parts.push(`${none} unresolved`);
  return [`Anchor mismatch: ${parts.join(", ")}.`, ...lines];
}

/** Format the failure headline, the publication fact, and per-failure facts within the detail budget. */
function formatFailureDetails(
  failure: ApplyFailure,
  snapshot: Readonly<{ currentText: string; anchors: AnchorFormatter }>,
  candidateLines: ReadonlySet<number>,
): string {
  const [headline, ...facts] =
    failure.kind === "anchor"
      ? describeAnchorFailures(failure.failures, snapshot, candidateLines)
      : [failure.message];
  return boundDiagnostic(
    [headline, NO_CHANGES_WRITTEN, ...facts].join("\n"),
    `\nDiagnostic output truncated at ${formatKiB(MAX_BLOCK_BYTES)}.`,
  );
}

/** The header qualifies every status, so the qualification survives truncation of the rows. */
function formatAnchorChecks(failure: ApplyFailure, anchors: AnchorFormatter): string {
  const rows = failure.checks.map(
    (check) =>
      `op ${check.opIndex} / ${check.which} / ${anchors.reference(check.cited.line, check.cited.hash)} / ${check.status}`,
  );
  return boundDiagnostic(
    ["Input-anchor checks (checksum only; this snapshot):", ...rows].join("\n"),
    `\nAnchor-check output truncated at ${formatKiB(MAX_BLOCK_BYTES)}; omitted entries are not implied matched.`,
  );
}

/**
 * Join the independently bounded fact blocks, then state the recovery instruction once.
 * Validation status and observation context stay visible even when failure details are truncated.
 */
export function formatFailure(
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
  const guidance = failure.kind === "anchor" ? `\n${ANCHOR_RECOVERY_GUIDANCE}` : "";
  const anchorChecks =
    isBatch && failure.checks.length > 0
      ? `\n${formatAnchorChecks(failure, snapshot.anchors)}`
      : "";
  return `${formatFailureDetails(failure, snapshot, candidateNeighborhoods.shownLines)}${anchorChecks}${candidateNeighborhoods.text}${guidance}`;
}

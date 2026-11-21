/**
 * Pure-function applicator: applies edits to a file's current text.
 *
 * Verification is live and surgical: each anchor's hash is recomputed from the
 * CURRENT line content at the cited line number and compared to the cited hash.
 * No prior-read revision guard — a line that changed (or was
 * misremembered) fails its own anchor; unchanged lines elsewhere never block
 * the edit.
 *
 * Shifted-anchor recovery: on mismatch, scan ±radius first, then the rest of the
 * file only if no nearby candidates match. Hold the ORIGINAL line number fixed
 * when hashing candidate content; matches are candidates, not proof of identity.
 * Return anchors hashed at their real positions for the caller to inspect and
 * retry. Several hits are ambiguous; radius 0 disables recovery.
 *
 * Batch semantics: all ops are verified against the same current snapshot. If
 * ANY anchor fails, EVERY failure (with recovery) is collected and returned
 * together — nothing is written. This keeps the rescue report and the on-disk
 * file in sync: a partial write would shift lines and invalidate the very
 * recovery info we just returned. Overlaps among the surviving ops are deferred
 * until anchors are corrected. The tool layer has already rejected reversed
 * ranges.
 *
 * Other strict semantics:
 * - Operation ranges must not overlap, and each position takes at most one insertion.
 *   An insertion at the start of a replaced or deleted range applies before that range.
 * - Byte-identical output is a success; the commit layer reports it as a no-op.
 *
 * @module pi-hashline-edit/core
 */

import { computeLineHash } from "./hash.ts";
import {
  newLineSeparator,
  hasFinalNewline,
  indexSourceLines,
  joinTextFragments,
  restoreLineEndings,
  type TextFragment,
} from "./lines.ts";
import type { Anchor, AnchorFailure, AnchorRecovery, ApplyResult, Edit } from "./types.ts";
import { HashlineError } from "./errors.ts";
import { findSortedRangeConflict } from "./ranges.ts";

/** Replace `[lo, hi)` with caller text. */
interface SpanOp {
  readonly lo: number;
  readonly hi: number;
  readonly newLines: readonly string[];
}

/**
 * Verify an anchor against the live content; on mismatch, attempt shifted
 * recovery. Returns null when the anchor matches, otherwise an
 * {@link AnchorFailure} carrying the recovery outcome.
 *
 * Recovery holds the ORIGINAL line number fixed and re-hashes each candidate's
 * content. A matching checksum identifies a candidate, not proof of the
 * original line's identity: short checksums can collide.
 * A returned candidate's anchor uses the candidate's real line number with a
 * hash computed for that line, so it verifies on retry.
 */
function verifyAnchor(
  lines: ReturnType<typeof indexSourceLines>,
  cited: Anchor,
  which: AnchorFailure["which"],
  opIndex: number,
  op: Edit["op"],
  hashLen: number,
  radius: number,
): AnchorFailure | null {
  const { line, hash } = cited;
  if (line <= lines.length && computeLineHash(line, lines.content(line - 1), hashLen) === hash)
    return null;

  const candidates: { line: number; hash: string }[] = [];
  const scan = (start: number, end: number) => {
    for (let c = start; c <= end; c++) {
      if (c === line) continue;
      const content = lines.content(c - 1);
      if (computeLineHash(line, content, hashLen) === hash) {
        candidates.push({ line: c, hash: computeLineHash(c, content, hashLen) });
      }
    }
  };
  if (radius > 0) {
    const lo = Math.max(1, line - radius);
    const hi = Math.min(lines.length, line + radius);
    scan(lo, hi);
    // Preserve local candidates; scan both remaining regions before deciding uniqueness.
    if (candidates.length === 0) {
      scan(1, Math.min(lines.length, lo - 1));
      scan(Math.max(1, hi + 1), lines.length);
    }
  }

  let recovery: AnchorRecovery;
  if (candidates.length === 1) {
    recovery = { kind: "found", newLine: candidates[0].line, newHash: candidates[0].hash };
  } else if (candidates.length > 1) {
    recovery = { kind: "ambiguous", candidates };
  } else {
    recovery = { kind: "none" };
  }

  return { opIndex, which, op, cited, recovery };
}

/** Verify each cited endpoint in input order, including the end of a failed range. */
function verifyEditAnchors(
  edits: readonly Edit[],
  lines: ReturnType<typeof indexSourceLines>,
  hashLen: number,
  radius: number,
): AnchorFailure[] {
  const failures: AnchorFailure[] = [];
  for (const [opIndex, edit] of edits.entries()) {
    if (!("anchor" in edit)) continue;
    const anchor = verifyAnchor(lines, edit.anchor, "anchor", opIndex, edit.op, hashLen, radius);
    if (anchor) failures.push(anchor);
    if (!("end" in edit) || !edit.end) continue;
    const end = verifyAnchor(lines, edit.end, "end", opIndex, edit.op, hashLen, radius);
    if (end) failures.push(end);
  }
  return failures;
}

/** Convert verified line addresses to half-open spans. */
function planSpan(edit: Edit, lineCount: number): SpanOp {
  switch (edit.op) {
    case "replace":
    case "delete":
      return {
        lo: edit.anchor.line - 1,
        hi: (edit.end ?? edit.anchor).line,
        newLines: edit.op === "replace" ? edit.body : [],
      };
    case "insert_after":
    case "insert_before": {
      const line = edit.anchor.line - (edit.op === "insert_before" ? 1 : 0);
      return { lo: line, hi: line, newLines: edit.body };
    }
    case "append":
      return { lo: lineCount, hi: lineCount, newLines: edit.body };
    case "prepend":
      return { lo: 0, hi: 0, newLines: edit.body };
  }
}

/**
 * Apply edits to `text`. Anchors are verified against the current content.
 * On any anchor mismatch, all failures (with shifted recovery) are collected
 * and returned together.
 *
 * @param text        current full file text
 * @param edits       validated edit operations; each body element is one logical line
 * @param hashLen     hash length used to verify anchors
 * @param shiftRadius first-pass ±line radius before full-file recovery; 0 disables recovery
 */
export function applyEdits(
  text: string,
  edits: readonly Edit[],
  hashLen: number,
  shiftRadius: number,
): ApplyResult {
  const lines = indexSourceLines(text);

  // Report anchor failures before checking the resulting spans for conflicts.
  const anchorFailures = verifyEditAnchors(edits, lines, hashLen, shiftRadius);
  if (anchorFailures.length > 0) return { ok: false, failures: anchorFailures };

  const sorted = edits
    .map((edit, opIndex) => ({ ...planSpan(edit, lines.length), opIndex }))
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const conflict = findSortedRangeConflict(
    sorted.map((op) => [op.lo, op.hi]),
    "allow-insertion-before-range",
  );
  if (conflict !== undefined) {
    const current = sorted[conflict];
    const previous = sorted[conflict - 1];
    // At an empty span, only another insertion at the same gap can conflict.
    const repeatedInsertion = previous.lo === previous.hi;
    throw new HashlineError(
      "OVERLAPPING_EDITS",
      repeatedInsertion ? "Two steps insert at one position." : "Two steps overlap.",
      {
        // The first conflicting pair found, ascending.
        facts: {
          conflict: [
            `steps[${Math.min(previous.opIndex, current.opIndex)}]`,
            `steps[${Math.max(previous.opIndex, current.opIndex)}]`,
          ],
        },
      },
    );
  }

  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const separator = newLineSeparator(text);
  const contentStart = (line: number) => (line === 0 ? bom.length : lines.start(line));
  /** The source gap after a line, or the separator after an unterminated last line. */
  const gapAfter = (line: number): TextFragment => {
    const start = lines.end(line);
    const end = lines.start(line + 1);
    return start !== end ? [start, end] : separator;
  };

  // The previous span's trailing gap connects to the next span, unless it ends the file.
  const parts: TextFragment[] = [[0, bom.length]];
  let lineCount = 0;
  let lastLineEmpty = false;
  let trailingGap: TextFragment = "";
  const appendSpan = (
    content: TextFragment,
    count: number,
    endsEmpty: boolean,
    gap: TextFragment,
  ) => {
    parts.push(trailingGap, content);
    lineCount += count;
    lastLineEmpty = endsEmpty;
    trailingGap = gap;
  };

  const appendSource = (start: number, end: number) => {
    if (start === end) return;
    const last = end - 1;
    const sourceStart = contentStart(start);
    const contentEnd = lines.end(last);
    appendSpan(
      [sourceStart, contentEnd],
      end - start,
      contentStart(last) === contentEnd,
      gapAfter(last),
    );
  };

  let cursor = 0;
  for (const op of sorted) {
    appendSource(cursor, op.lo);
    cursor = op.hi;
    if (op.newLines.length === 0) continue;

    let logical = op.newLines.join("\n");
    // Only replacement of the original first line can carry a copied file BOM.
    if (bom && op.lo === 0 && op.hi > 0 && logical.startsWith(bom)) logical = logical.slice(1);

    // Borrow only the internal gaps the body can use. Keep the replaced range's
    // trailing gap at its right boundary.
    const usedGaps = Math.min(op.hi - op.lo, op.newLines.length) - 1;
    const oldInternal =
      usedGaps > 0 && separator === "\r\n"
        ? text.slice(lines.end(op.lo), lines.start(op.lo + usedGaps))
        : "";
    appendSpan(
      op.newLines.length > 1 ? restoreLineEndings(logical, oldInternal, separator) : logical,
      op.newLines.length,
      logical === "" || logical.endsWith("\n"),
      op.hi > op.lo ? gapAfter(op.hi - 1) : separator,
    );
  }
  appendSource(cursor, lines.length);

  // A final blank line needs a terminator unless the BOM alone represents it.
  if (hasFinalNewline(text) || (lastLineEmpty && (lineCount > 1 || !bom))) {
    parts.push(trailingGap);
  }
  return { ok: true, ...joinTextFragments(text, parts) };
}

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

type TranslateResult =
  | { readonly ok: true; readonly op: SpanOp }
  | { readonly ok: false; readonly anchorFailures: AnchorFailure[] };

/** Verify an Edit against the snapshot and plan its mutation span. */
function translateEdit(
  edit: Edit,
  opIndex: number,
  lines: ReturnType<typeof indexSourceLines>,
  hashLen: number,
  radius: number,
): TranslateResult {
  const verify = (cited: Anchor, which: AnchorFailure["which"]) =>
    verifyAnchor(lines, cited, which, opIndex, edit.op, hashLen, radius);
  switch (edit.op) {
    case "replace":
    case "delete": {
      const failures: AnchorFailure[] = [];
      const anchorF = verify(edit.anchor, "anchor");
      if (anchorF) failures.push(anchorF);
      let endLine = edit.anchor.line;
      if (edit.end) {
        const endF = verify(edit.end, "end");
        if (endF) failures.push(endF);
        endLine = edit.end.line;
      }
      if (failures.length > 0) return { ok: false, anchorFailures: failures };
      return {
        ok: true,
        op: {
          lo: edit.anchor.line - 1,
          hi: endLine,
          newLines: edit.op === "replace" ? edit.body : [],
        },
      };
    }
    case "insert_after":
    case "insert_before": {
      const failure = verify(edit.anchor, "anchor");
      if (failure) return { ok: false, anchorFailures: [failure] };
      const line = edit.anchor.line - (edit.op === "insert_before" ? 1 : 0);
      return { ok: true, op: { lo: line, hi: line, newLines: edit.body } };
    }
    case "append":
      return { ok: true, op: { lo: lines.length, hi: lines.length, newLines: edit.body } };
    case "prepend":
      return { ok: true, op: { lo: 0, hi: 0, newLines: edit.body } };
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

  const ops: (SpanOp & { readonly opIndex: number })[] = [];
  const anchorFailures: AnchorFailure[] = [];

  for (let i = 0; i < edits.length; i++) {
    const t = translateEdit(edits[i], i, lines, hashLen, shiftRadius);
    if (t.ok) {
      ops.push({ ...t.op, opIndex: i });
    } else {
      anchorFailures.push(...t.anchorFailures);
    }
  }

  // Anchor failures take priority: the model must fix anchors first; overlaps
  // among surviving ops are premature until anchors are corrected.
  if (anchorFailures.length > 0) {
    return { ok: false, failures: anchorFailures };
  }

  const sorted = ops.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const conflict = findSortedRangeConflict(
    sorted.map((op) => [op.lo, op.hi]),
    true,
  );
  if (conflict !== undefined) {
    const current = sorted[conflict];
    const previous = sorted[conflict - 1];
    const repeatedInsertion =
      current.lo === current.hi && previous.lo === current.lo && previous.hi === current.hi;
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
  const gapAfter = (line: number): TextFragment | undefined => {
    const sourceStart = lines.end(line);
    const end = lines.start(line + 1);
    if (sourceStart !== end) return { text: text.slice(sourceStart, end), sourceStart };
  };

  // The previous span's trailing gap connects to the next span, unless it ends the file.
  const parts: TextFragment[] = [{ text: bom, sourceStart: 0 }];
  const fallbackGap = { text: separator };
  let lineCount = 0;
  let lastLineEmpty = false;
  let trailingGap: TextFragment | undefined;
  const appendSpan = (
    content: TextFragment,
    count: number,
    endsEmpty: boolean,
    gap: TextFragment | undefined,
  ) => {
    if (lineCount > 0) parts.push(trailingGap ?? fallbackGap);
    parts.push(content);
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
      { text: text.slice(sourceStart, contentEnd), sourceStart },
      end - start,
      contentStart(last) === contentEnd,
      gapAfter(last),
    );
  };

  let cursor = 0;
  for (const op of sorted) {
    appendSource(cursor, op.lo);
    if (op.newLines.length > 0) {
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
        {
          text:
            op.newLines.length > 1 ? restoreLineEndings(logical, oldInternal, separator) : logical,
        },
        op.newLines.length,
        logical === "" || logical.endsWith("\n"),
        op.hi > op.lo ? gapAfter(op.hi - 1) : undefined,
      );
    }
    cursor = op.hi;
  }
  appendSource(cursor, lines.length);

  // A final blank line needs a terminator unless the BOM alone represents it.
  if (lineCount > 0 && (hasFinalNewline(text) || (lastLineEmpty && (lineCount > 1 || !bom)))) {
    parts.push(trailingGap ?? fallbackGap);
  }
  return { ok: true, ...joinTextFragments(parts) };
}

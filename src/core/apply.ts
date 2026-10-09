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
 * recovery info we just returned. Range issues among the surviving ops are
 * deferred until anchors are corrected.
 *
 * Other strict semantics:
 * - Operation ranges must not overlap (including the same insertion point).
 * - Byte-identical output succeeds with changed=false and no updated anchors.
 *
 * @module pi-hashline-edit/core
 */

import { computeLineHash } from "./hash.ts";
import {
  detectLineEnding,
  hasFinalNewline,
  lineSeparators,
  replacementSeparator,
  splitLines,
} from "./lines.ts";
import type {
  Anchor,
  AnchorCheck,
  AnchorFailure,
  AnchorRecovery,
  ApplyFailure,
  ApplyResult,
  Edit,
} from "./types.ts";
import { findSortedRangeConflict } from "./ranges.ts";

/** Replace `[lo, hi)` with caller text or a range captured from the verified original lines. */
type SpanOp = { readonly lo: number; readonly hi: number } & (
  | { readonly kind: "body"; readonly newLines: readonly string[] }
  | { readonly kind: "capture"; readonly sourceLo: number; readonly sourceHi: number }
);

function producedLineCount(op: SpanOp): number {
  return op.kind === "body" ? op.newLines.length : op.sourceHi - op.sourceLo;
}

/**
 * Verify an anchor against the live content; on mismatch, attempt shifted
 * recovery. Returns null when the anchor matches, otherwise an
 * {@link AnchorFailure} carrying the recovery outcome and the cited line's
 * current snapshot.
 *
 * Recovery holds the ORIGINAL line number fixed and re-hashes each candidate's
 * content. A matching checksum identifies a candidate, not proof of the
 * original line's identity: short checksums can collide.
 * A returned candidate's anchor uses the candidate's real line number with a
 * hash computed for that line, so it verifies on retry.
 */
function verifyAnchor(
  lines: readonly string[],
  cited: Anchor,
  which: AnchorCheck["which"],
  opIndex: number,
  op: Edit["op"],
  hashLen: number,
  radius: number,
): AnchorFailure | null {
  const { line, hash } = cited;
  if (
    line >= 1 &&
    line <= lines.length &&
    computeLineHash(line, lines[line - 1], hashLen) === hash
  ) {
    return null;
  }

  const candidates: { line: number; hash: string }[] = [];
  let scope: "local" | "full-file" = "local";
  const scan = (start: number, end: number) => {
    for (let c = start; c <= end; c++) {
      if (c === line) continue;
      if (computeLineHash(line, lines[c - 1], hashLen) === hash) {
        candidates.push({ line: c, hash: computeLineHash(c, lines[c - 1], hashLen) });
      }
    }
  };
  if (radius > 0) {
    const lo = Math.max(1, line - radius);
    const hi = Math.min(lines.length, line + radius);
    scan(lo, hi);
    // Preserve local candidates; scan both remaining regions before deciding uniqueness.
    if (candidates.length === 0) {
      scope = "full-file";
      scan(1, Math.min(lines.length, lo - 1));
      scan(Math.max(1, hi + 1), lines.length);
    }
  }

  let recovery: AnchorRecovery;
  if (candidates.length === 1) {
    recovery = { kind: "found", scope, newLine: candidates[0].line, newHash: candidates[0].hash };
  } else if (candidates.length > 1) {
    recovery = { kind: "ambiguous", scope, candidates };
  } else {
    recovery = { kind: "none" };
  }

  const current =
    line >= 1 && line <= lines.length
      ? { hash: computeLineHash(line, lines[line - 1], hashLen), content: lines[line - 1] }
      : null;

  return { opIndex, which, op, cited, recovery, current };
}

type TranslateResult =
  | { readonly ok: true; readonly ops: readonly SpanOp[]; readonly checks: AnchorCheck[] }
  | { readonly ok: false; readonly anchorFailures: AnchorFailure[]; readonly checks: AnchorCheck[] }
  | { readonly ok: false; readonly rangeError: RangeError; readonly checks: AnchorCheck[] };

type RangeError = Pick<Extract<ApplyFailure, { kind: "range" }>, "code" | "message">;

function checkedAnchor(
  edit: Edit,
  opIndex: number,
  which: AnchorCheck["which"],
  cited: Anchor,
  failure: AnchorFailure | null,
): AnchorCheck {
  return { opIndex, which, op: edit.op, cited, status: failure ? "mismatched" : "matched" };
}

/** Verify an Edit against the snapshot and plan its mutation spans and captured source. */
function translateEdit(
  edit: Edit,
  opIndex: number,
  lines: readonly string[],
  hashLen: number,
  radius: number,
): TranslateResult {
  switch (edit.op) {
    case "replace":
    case "delete":
    case "copy":
    case "move": {
      const failures: AnchorFailure[] = [];
      const checks: AnchorCheck[] = [];
      const startF = verifyAnchor(lines, edit.start, "anchor", opIndex, edit.op, hashLen, radius);
      checks.push(checkedAnchor(edit, opIndex, "anchor", edit.start, startF));
      if (startF) failures.push(startF);
      let endLine = edit.start.line;
      if (edit.end) {
        const endF = verifyAnchor(lines, edit.end, "end", opIndex, edit.op, hashLen, radius);
        checks.push(checkedAnchor(edit, opIndex, "end", edit.end, endF));
        if (endF) failures.push(endF);
        endLine = edit.end.line;
      }
      const destination =
        edit.op === "copy" || edit.op === "move"
          ? edit.before !== undefined
            ? { which: "before" as const, cited: edit.before }
            : { which: "after" as const, cited: edit.after }
          : undefined;
      if (destination) {
        const failure = verifyAnchor(
          lines,
          destination.cited,
          destination.which,
          opIndex,
          edit.op,
          hashLen,
          radius,
        );
        checks.push(checkedAnchor(edit, opIndex, destination.which, destination.cited, failure));
        if (failure) failures.push(failure);
      }
      if (failures.length > 0) return { ok: false, anchorFailures: failures, checks };
      if (endLine < edit.start.line)
        return {
          ok: false,
          rangeError: {
            code: "INVALID_RANGE",
            message: `Range ${edit.start.line}..${endLine} ends before it starts.`,
          },
          checks,
        };
      if (destination) {
        const sourceLo = edit.start.line - 1;
        const gap = destination.cited.line - (destination.which === "before" ? 1 : 0);
        if (edit.op === "move" && sourceLo < gap && gap < endLine) {
          return {
            ok: false,
            rangeError: {
              code: "INVALID_RANGE",
              message: `Destination ${destination.which} line ${destination.cited.line} lies inside moved range ${edit.start.line}..${endLine}.`,
            },
            checks,
          };
        }
        if (edit.op === "move" && (gap === sourceLo || gap === endLine)) {
          return { ok: true, ops: [], checks };
        }
        const insertion: SpanOp = {
          lo: gap,
          hi: gap,
          kind: "capture",
          sourceLo,
          sourceHi: endLine,
        };
        return {
          ok: true,
          checks,
          ops:
            edit.op === "move"
              ? [insertion, { lo: sourceLo, hi: endLine, kind: "body", newLines: [] }]
              : [insertion],
        };
      }
      return {
        ok: true,
        checks,
        ops: [
          {
            lo: edit.start.line - 1,
            hi: endLine,
            kind: "body",
            newLines: edit.op === "replace" ? edit.body : [],
          },
        ],
      };
    }
    case "insert_after":
    case "insert_before": {
      const failure = verifyAnchor(lines, edit.anchor, "anchor", opIndex, edit.op, hashLen, radius);
      const checks = [checkedAnchor(edit, opIndex, "anchor", edit.anchor, failure)];
      if (failure) return { ok: false, anchorFailures: [failure], checks };
      const line = edit.anchor.line - (edit.op === "insert_before" ? 1 : 0);
      return { ok: true, checks, ops: [{ lo: line, hi: line, kind: "body", newLines: edit.body }] };
    }
    case "append":
      return {
        ok: true,
        checks: [],
        ops: [{ lo: lines.length, hi: lines.length, kind: "body", newLines: edit.body }],
      };
    case "prepend":
      return { ok: true, checks: [], ops: [{ lo: 0, hi: 0, kind: "body", newLines: edit.body }] };
  }
}

/**
 * Apply edits to `text`. Anchors are verified against the current content; on
 * success `touchedLines` gives the 0-based indices of the new-file lines this
 * edit produced. On any anchor mismatch, all failures (with shifted recovery)
 * are collected and returned together — nothing is written. Every failure includes
 * per-input anchor checks.
 *
 * @param text        current full file text
 * @param edits       validated edit operations; each body element is one logical line
 * @param hashLen     hash length used to verify anchors
 * @param shiftRadius first-pass ±line radius before full-file recovery; 0 disables recovery
 */
export function applyEdits(
  text: string,
  edits: Edit[],
  hashLen: number,
  shiftRadius: number,
): ApplyResult {
  const lines = splitLines(text);
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const ending = detectLineEnding(text);

  const ops: SpanOp[] = [];
  const anchorFailures: AnchorFailure[] = [];
  const anchorChecks: AnchorCheck[] = [];
  let rangeError: RangeError | null = null;

  for (let i = 0; i < edits.length; i++) {
    const t = translateEdit(edits[i], i, lines, hashLen, shiftRadius);
    anchorChecks.push(...t.checks);
    if (t.ok) {
      for (const op of t.ops) ops.push(op);
    } else if ("anchorFailures" in t) {
      anchorFailures.push(...t.anchorFailures);
    } else if (rangeError === null) {
      rangeError = t.rangeError;
    }
  }

  // Anchor failures take priority: the model must fix anchors first; range
  // issues among surviving ops are premature until anchors are corrected.
  if (anchorFailures.length > 0) {
    return {
      ok: false,
      failure: { kind: "anchor", failures: anchorFailures, checks: anchorChecks },
    };
  }
  if (rangeError !== null) {
    return { ok: false, failure: { kind: "range", ...rangeError, checks: anchorChecks } };
  }

  const sorted = [...ops].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const conflict = findSortedRangeConflict(sorted.map((op) => [op.lo, op.hi]));
  if (conflict !== undefined) {
    return {
      ok: false,
      failure: {
        kind: "range",
        code: "OVERLAPPING_EDITS",
        message: `Edits overlap near line ${sorted[conflict].lo + 1}.`,
        checks: anchorChecks,
      },
    };
  }

  // Mixed line endings: each line carries the separator that FOLLOWED it in
  // the original (its gap), so surviving lines keep theirs byte for byte. New
  // gaps borrow the removed block's separators positionally — the last new
  // line inherits the block's trailing gap, leaving the boundary to the next
  // surviving line unchanged. Internal gaps use the same positional/last-gap
  // rule as substring replacements, falling back to the file style for insertions.
  const separator = ending === "crlf" ? "\r\n" : "\n";
  // LF-only files have uniform separators; skip the regex scan.
  const separators = ending === "lf" ? undefined : lineSeparators(text);
  // Build from the verified snapshot in one pass: large bodies must not become
  // function arguments, and later operations keep their original coordinates.
  const result: { content: string; separator: string }[] = [];
  let cursor = 0;
  const appendSource = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      const content = lines[index];
      // Keep the verified first-line BOM at byte zero, including for captured ranges.
      result.push({
        content: bom && index === 0 ? content.slice(1) : content,
        separator: separators?.[index] ?? "",
      });
    }
  };
  for (const op of sorted) {
    appendSource(cursor, op.lo);
    if (op.kind === "capture") {
      appendSource(op.sourceLo, op.sourceHi);
      cursor = op.hi;
      continue;
    }
    // The trailing gap is outside the logical replacement, just as in substring replacement.
    const removedSeparators = separators?.slice(op.lo, Math.max(op.lo, op.hi - 1)) ?? [];
    for (let i = 0; i < op.newLines.length; i++) {
      const content = op.newLines[i];
      result.push({
        // A copied first-line BOM denotes the existing file header, not a second BOM.
        content:
          bom && op.lo === 0 && i === 0 && content.startsWith(bom) ? content.slice(1) : content,
        separator:
          i === op.newLines.length - 1 && op.hi > op.lo
            ? (separators?.[op.hi - 1] ?? "")
            : replacementSeparator(removedSeparators, i, separator),
      });
    }
    cursor = op.hi;
  }
  appendSource(cursor, lines.length);
  // An empty final logical line needs its own terminator to survive splitLines.
  // A sole BOM-backed line already has a representation without a terminator.
  const finalNewline =
    hasFinalNewline(text) || (result.at(-1)?.content === "" && (result.length > 1 || !bom));
  const newText =
    bom +
    result
      .map(
        ({ content, separator: current }, i) =>
          content +
          (i < result.length - 1 || finalNewline
            ? current || (content.endsWith("\r") ? "\r\n" : separator)
            : ""),
      )
      .join("");
  if (newText === text) {
    return { ok: true, text, changed: false, touchedLines: [], contextLines: [] };
  }

  // touchedLines: new-file indices worth re-anchoring — each produced line,
  // and for a pure delete the line that shifted into the gap (so the model
  // gets a fresh anchor for the shifted region).
  const touched: number[] = [];
  const contextLines = new Set<number>();
  let delta = 0;
  for (const op of sorted) {
    const newLo = op.lo + delta;
    const count = producedLineCount(op);
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        touched.push(newLo + i);
        // An adjacent replacement may supply the deletion successor itself.
        contextLines.delete(newLo + i);
      }
    } else if (op.hi > op.lo && newLo < result.length) {
      touched.push(newLo);
      contextLines.add(newLo);
    }
    delta += count - (op.hi - op.lo);
  }

  return {
    ok: true,
    text: newText,
    changed: true,
    touchedLines: touched,
    contextLines: [...contextLines],
  };
}

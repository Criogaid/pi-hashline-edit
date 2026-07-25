/**
 * Pure-function applicator: applies edits to a file's current text.
 *
 * Verification is live and surgical: each anchor's hash is recomputed from the
 * CURRENT line content at the cited line number and compared to the cited hash.
 * No snapshot, no global stale check — a line that changed (or was
 * misremembered) fails its own anchor; unchanged lines elsewhere never block
 * the edit.
 *
 * Shifted-anchor recovery: when a cited anchor no longer matches, we rescan
 * ±radius lines for the original content, holding the ORIGINAL line number fixed
 * and re-hashing each candidate's content. On a unique hit the new anchor (with
 * its freshly computed hash) is returned so the caller can retry without a
 * re-read; on several hits they are reported as ambiguous; on none the live
 * content at the cited line is returned to steer a re-read.
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
 * - body byte-identical to the whole-file result → `noop` error (guides the
 *   model to investigate rather than blindly retry).
 *
 * @module pi-hashline-edit/core
 */

import { computeLineHash } from "./hash.ts";
import { detectLineEnding, joinLines, splitLines } from "./lines.ts";
import type { Anchor, AnchorFailure, AnchorRecovery, ApplyResult, Edit } from "./types.ts";

/** Line-level operation: replace the raw lines in the `[lo, hi)` range (0-based, hi exclusive) with newLines. */
interface SpanOp {
	lo: number;
	hi: number;
	newLines: string[];
}

/** Default ±line radius for shifted-anchor recovery. */
const DEFAULT_SHIFT_RADIUS = 15;

/**
 * Verify an anchor against the live content; on mismatch, attempt shifted
 * recovery. Returns null when the anchor matches, otherwise an
 * {@link AnchorFailure} carrying the recovery outcome and the cited line's
 * current snapshot.
 *
 * Recovery holds the ORIGINAL line number fixed and re-hashes each candidate's
 * content: `computeLineHash(citedLine, candidateContent) === citedHash` holds
 * iff the candidate IS the original content (modulo negligible hash collision).
 * A returned candidate's anchor uses the candidate's real line number with a
 * hash computed for that line, so it verifies on retry.
 */
function verifyAnchor(
	lines: readonly string[],
	cited: Anchor,
	which: "anchor" | "end",
	opIndex: number,
	op: Edit["op"],
	hashLen: number,
	radius: number,
): AnchorFailure | null {
	const { line, hash } = cited;
	if (line >= 1 && line <= lines.length && computeLineHash(line, lines[line - 1], hashLen) === hash) {
		return null;
	}

	// Shifted recovery: scan ±radius (excluding the already-failed cited line).
	const candidates: { line: number; hash: string }[] = [];
	const lo = Math.max(1, line - radius);
	const hi = Math.min(lines.length, line + radius);
	for (let c = lo; c <= hi; c++) {
		if (c === line) continue;
		if (computeLineHash(line, lines[c - 1], hashLen) === hash) {
			candidates.push({ line: c, hash: computeLineHash(c, lines[c - 1], hashLen) });
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

	const current =
		line >= 1 && line <= lines.length
			? { hash: computeLineHash(line, lines[line - 1], hashLen), content: lines[line - 1] }
			: null;

	return { opIndex, which, op, cited, recovery, current };
}

type TranslateResult =
	| { readonly ok: true; readonly op: SpanOp }
	| { readonly ok: false; readonly anchorFailures: AnchorFailure[] }
	| { readonly ok: false; readonly rangeError: string };

/** Translate an Edit into a SpanOp, verifying anchors and ranges against the current lines. */
function translateEdit(
	edit: Edit,
	opIndex: number,
	lines: readonly string[],
	hashLen: number,
	radius: number,
): TranslateResult {
	switch (edit.op) {
		case "replace":
		case "delete": {
			const failures: AnchorFailure[] = [];
			const startF = verifyAnchor(lines, edit.start, "anchor", opIndex, edit.op, hashLen, radius);
			if (startF) failures.push(startF);
			let endLine = edit.start.line;
			if (edit.end) {
				const endF = verifyAnchor(lines, edit.end, "end", opIndex, edit.op, hashLen, radius);
				if (endF) failures.push(endF);
				endLine = edit.end.line;
			}
			if (failures.length > 0) return { ok: false, anchorFailures: failures };
			if (endLine < edit.start.line) {
				return { ok: false, rangeError: `range ${edit.start.line}..${endLine} ends before it starts` };
			}
			return {
				ok: true,
				op: {
					lo: edit.start.line - 1,
					hi: endLine,
					newLines: edit.op === "delete" ? [] : edit.body,
				},
			};
		}
		case "insert_after": {
			const f = verifyAnchor(lines, edit.anchor, "anchor", opIndex, edit.op, hashLen, radius);
			if (f) return { ok: false, anchorFailures: [f] };
			return { ok: true, op: { lo: edit.anchor.line, hi: edit.anchor.line, newLines: edit.body } };
		}
		case "insert_before": {
			const f = verifyAnchor(lines, edit.anchor, "anchor", opIndex, edit.op, hashLen, radius);
			if (f) return { ok: false, anchorFailures: [f] };
			return { ok: true, op: { lo: edit.anchor.line - 1, hi: edit.anchor.line - 1, newLines: edit.body } };
		}
		case "append": {
			return { ok: true, op: { lo: lines.length, hi: lines.length, newLines: edit.body } };
		}
		case "prepend": {
			return { ok: true, op: { lo: 0, hi: 0, newLines: edit.body } };
		}
	}
}

/** The "last affected position" of a zero-width range (insertion point) is lo; otherwise hi-1. */
function maxAffected(op: SpanOp): number {
	return op.lo === op.hi ? op.lo : op.hi - 1;
}

/**
 * Apply edits to `text`. Anchors are verified against the current content; on
 * success `touchedLines` gives the 0-based indices of the new-file lines this
 * edit produced. On any anchor mismatch, all failures (with shifted recovery)
 * are collected and returned together — nothing is written.
 *
 * @param text        current full file text
 * @param edits       parsed edit operations
 * @param hashLen     hash length used to verify anchors (default 4)
 * @param shiftRadius ±line radius for shifted-anchor recovery (default 15; 0 disables rescue)
 */
export function applyEdits(text: string, edits: Edit[], hashLen = 4, shiftRadius = DEFAULT_SHIFT_RADIUS): ApplyResult {
	const lines = splitLines(text);
	const ending = detectLineEnding(text);

	const ops: SpanOp[] = [];
	const anchorFailures: AnchorFailure[] = [];
	let rangeError: string | null = null;

	for (let i = 0; i < edits.length; i++) {
		const t = translateEdit(edits[i], i, lines, hashLen, shiftRadius);
		if (t.ok) {
			ops.push(t.op);
		} else if ("anchorFailures" in t) {
			anchorFailures.push(...t.anchorFailures);
		} else if (rangeError === null) {
			rangeError = t.rangeError;
		}
	}

	// Anchor failures take priority: the model must fix anchors first; range
	// issues among surviving ops are premature until anchors are corrected.
	if (anchorFailures.length > 0) {
		return { ok: false, failure: { kind: "anchor", failures: anchorFailures } };
	}
	if (rangeError !== null) {
		return { ok: false, failure: { kind: "range", message: rangeError } };
	}

	// Overlap check: sort ascending by lo; the next op's start must not fall inside the previous op's affected range
	const sorted = [...ops].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
	for (let k = 1; k < sorted.length; k++) {
		if (sorted[k].lo <= maxAffected(sorted[k - 1])) {
			return {
				ok: false,
				failure: {
					kind: "range",
					message: `overlapping edits near line ${sorted[k].lo + 1}; issue one edit per range`,
				},
			};
		}
	}

	// Apply back-to-front (lo descending) so original lo/hi stay valid
	let result = [...lines];
	for (const op of [...sorted].sort((a, b) => b.lo - a.lo)) {
		result = [...result.slice(0, op.lo), ...op.newLines, ...result.slice(op.hi)];
	}

	const newText = joinLines(result, ending);
	if (newText === text) {
		return {
			ok: false,
			failure: {
				kind: "noop",
				message: "edit parsed and applied cleanly but produced no change; body is byte-identical — the bug is elsewhere, re-read first",
			},
		};
	}

	// touchedLines: new-file indices worth re-anchoring — each produced line,
	// and for a pure delete the line that shifted into the gap (so the model
	// gets a fresh anchor for the shifted region).
	const touched: number[] = [];
	let delta = 0;
	for (const op of sorted) {
		const newLo = op.lo + delta;
		if (op.newLines.length > 0) {
			for (let i = 0; i < op.newLines.length; i++) touched.push(newLo + i);
		} else if (newLo < result.length) {
			touched.push(newLo);
		}
		delta += op.newLines.length - (op.hi - op.lo);
	}

	return { ok: true, text: newText, changed: true, touchedLines: touched };
}

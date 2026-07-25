/**
 * Pure-function applicator: applies edits to a file's current text.
 *
 * Verification is live and surgical: each anchor's hash is recomputed from the
 * CURRENT line content at the cited line number and compared to the cited hash.
 * No snapshot, no global stale check — a line that changed (or was
 * misremembered) fails its own anchor; unchanged lines elsewhere never block
 * the edit.
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
import type { Anchor, ApplyResult, Edit, PatchError } from "./types.ts";

/** Line-level operation: replace the raw lines in the `[lo, hi)` range (0-based, hi exclusive) with newLines. */
interface SpanOp {
	lo: number;
	hi: number;
	newLines: string[];
}

/** Verify an anchor against the current file: line in range and hash matches the live content. */
function checkAnchor(lines: readonly string[], line: number, hash: string, hashLen: number): PatchError | null {
	if (line < 1 || line > lines.length) {
		return {
			kind: "anchor",
			message: `line ${line} does not exist (file has ${lines.length} lines)`,
		};
	}
	if (computeLineHash(line, lines[line - 1], hashLen) !== hash) {
		return {
			kind: "anchor",
			message: `line ${line} changed or hash is wrong: re-read to get the current #HASH`,
		};
	}
	return null;
}

/** Translate an Edit into a SpanOp, verifying anchors and ranges against the current lines. */
function translateEdit(edit: Edit, lines: readonly string[], hashLen: number): { op: SpanOp } | { error: PatchError } {
	switch (edit.op) {
		case "replace":
		case "delete": {
			const startErr = checkAnchor(lines, edit.start.line, edit.start.hash, hashLen);
			if (startErr) return { error: startErr };
			let endLine = edit.start.line;
			if (edit.end) {
				const endErr = checkAnchor(lines, edit.end.line, edit.end.hash, hashLen);
				if (endErr) return { error: endErr };
				endLine = edit.end.line;
			}
			if (endLine < edit.start.line) {
				return { error: { kind: "range", message: `range ${edit.start.line}..${endLine} ends before it starts` } };
			}
			return {
				op: {
					lo: edit.start.line - 1,
					hi: endLine,
					newLines: edit.op === "delete" ? [] : edit.body,
				},
			};
		}
		case "insert_after": {
			const err = checkAnchor(lines, edit.anchor.line, edit.anchor.hash, hashLen);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line, hi: edit.anchor.line, newLines: edit.body } };
		}
		case "insert_before": {
			const err = checkAnchor(lines, edit.anchor.line, edit.anchor.hash, hashLen);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line - 1, hi: edit.anchor.line - 1, newLines: edit.body } };
		}
		case "append": {
			return { op: { lo: lines.length, hi: lines.length, newLines: edit.body } };
		}
		case "prepend": {
			return { op: { lo: 0, hi: 0, newLines: edit.body } };
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
 * edit produced.
 *
 * @param text    current full file text
 * @param edits   parsed edit operations
 * @param hashLen hash length used to verify anchors (default 4)
 */
export function applyEdits(text: string, edits: Edit[], hashLen = 4): ApplyResult {
	const lines = splitLines(text);
	const ending = detectLineEnding(text);

	const ops: SpanOp[] = [];
	for (const edit of edits) {
		const t = translateEdit(edit, lines, hashLen);
		if ("error" in t) return { ok: false, error: t.error };
		ops.push(t.op);
	}

	// Overlap check: sort ascending by lo; the next op's start must not fall inside the previous op's affected range
	const sorted = [...ops].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
	for (let k = 1; k < sorted.length; k++) {
		if (sorted[k].lo <= maxAffected(sorted[k - 1])) {
			return {
				ok: false,
				error: {
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
			error: {
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

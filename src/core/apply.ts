/**
 * Pure-function applicator: applies edits to the file backing a snapshot.
 *
 * Strict semantics:
 * - Requires the current `text === snapshot.text` (stale check); pure apply
 *   does not guess — a changed file is rejected.
 * - Each anchor's hash must match the snapshot at the cited line (guards
 *   against the model misremembering line numbers / hashes).
 * - Operation ranges must not overlap (including the same insertion point).
 * - body byte-identical to the target → `noop` error (guides the model to
 *   investigate the bug rather than blindly retry).
 *
 * @module pi-hashline-edit/core
 */

import { createSnapshot, joinLines, splitLines } from "./snapshot.ts";
import type { ApplyResult, Edit, FileSnapshot, PatchError } from "./types.ts";


/** Line-level operation: replace the raw lines in the `[lo, hi)` range (0-based, hi exclusive) with newLines. */
interface SpanOp {
	lo: number;
	hi: number;
	newLines: string[];
}

/** Verify the anchor matches the snapshot (pure apply: text already equals snapshot.text, so this only guards against misremembering). */
function checkAnchor(snapshot: FileSnapshot, line: number, hash: string): PatchError | null {
	if (line < 1 || line > snapshot.lineHashes.length) {
		return {
			kind: "anchor",
			message: `line ${line} does not exist (file has ${snapshot.lineHashes.length} lines)`,
		};
	}
	if (snapshot.lineHashes[line - 1] !== hash) {
		return {
			kind: "anchor",
			message: `hash mismatch at line ${line}: file has #${snapshot.lineHashes[line - 1]}, edit says #${hash}`,
		};
	}
	return null;
}

/** Translate an Edit into a SpanOp, while verifying anchors and ranges. */
function translateEdit(edit: Edit, snapshot: FileSnapshot): { op: SpanOp } | { error: PatchError } {
	switch (edit.op) {
		case "replace":
		case "delete": {
			const startErr = checkAnchor(snapshot, edit.start.line, edit.start.hash);
			if (startErr) return { error: startErr };
			let endLine = edit.start.line;
			if (edit.end) {
				const endErr = checkAnchor(snapshot, edit.end.line, edit.end.hash);
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
			const err = checkAnchor(snapshot, edit.anchor.line, edit.anchor.hash);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line, hi: edit.anchor.line, newLines: edit.body } };
		}
		case "insert_before": {
			const err = checkAnchor(snapshot, edit.anchor.line, edit.anchor.hash);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line - 1, hi: edit.anchor.line - 1, newLines: edit.body } };
		}
		case "append": {
			return { op: { lo: snapshot.lineHashes.length, hi: snapshot.lineHashes.length, newLines: edit.body } };
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
 * Apply edits to the file backing a snapshot.
 *
 * @param text     current full file text
 * @param edits    parsed edit operations
 * @param snapshot snapshot recorded at read time (text must equal current text)
 * @returns apply result; on failure returns a structured error
 */
export function applyEdits(text: string, edits: Edit[], snapshot: FileSnapshot): ApplyResult {
	if (text !== snapshot.text) {
		return {
			ok: false,
			error: { kind: "stale", message: "file changed since last read; re-read before editing" },
		};
	}

	const lines = splitLines(text);

	const ops: SpanOp[] = [];
	for (const edit of edits) {
		const t = translateEdit(edit, snapshot);
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

	// Apply back-to-front (lo descending) to avoid line-number shifts
	let result = [...lines];
	for (const op of [...sorted].sort((a, b) => b.lo - a.lo)) {
		result = [...result.slice(0, op.lo), ...op.newLines, ...result.slice(op.hi)];
	}

	const newText = joinLines(result, snapshot.lineEnding);
	if (newText === text) {
		return {
			ok: false,
			error: {
				kind: "noop",
				message:
					"edit parsed and applied cleanly but produced no change; body is byte-identical to the target — the bug is elsewhere, re-read first",
			},
		};
	}

	const newSnapshot = createSnapshot(snapshot.path, newText, snapshot.hashLen);
	return { ok: true, text: newText, newSnapshot, changed: true };
}

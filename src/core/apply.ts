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
import { detectLineEnding, hasFinalNewline, splitLines } from "./lines.ts";
import type { Anchor, AnchorCheck, AnchorFailure, AnchorRecovery, ApplyResult, Edit } from "./types.ts";
import { findSortedRangeConflict } from "./ranges.ts";

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
 * content. A matching checksum identifies a candidate, not proof of the
 * original line's identity: short checksums can collide.
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
	| { readonly ok: true; readonly op: SpanOp; readonly checks: AnchorCheck[] }
	| { readonly ok: false; readonly anchorFailures: AnchorFailure[]; readonly checks: AnchorCheck[] }
	| { readonly ok: false; readonly rangeError: string; readonly checks: AnchorCheck[] };

function checkedAnchor(edit: Edit, opIndex: number, which: "anchor" | "end", cited: Anchor, failure: AnchorFailure | null): AnchorCheck {
	return { opIndex, which, op: edit.op, cited, status: failure ? "mismatched" : "matched" };
}

function inputAnchorChecks(edits: readonly Edit[], status: AnchorCheck["status"]): AnchorCheck[] {
	const checks: AnchorCheck[] = [];
	for (let opIndex = 0; opIndex < edits.length; opIndex++) {
		const edit = edits[opIndex];
		if (edit.op === "replace" || edit.op === "delete") {
			checks.push({ opIndex, which: "anchor", op: edit.op, cited: edit.start, status });
			if (edit.end) checks.push({ opIndex, which: "end", op: edit.op, cited: edit.end, status });
		} else if (edit.op === "insert_after" || edit.op === "insert_before") {
			checks.push({ opIndex, which: "anchor", op: edit.op, cited: edit.anchor, status });
		}
	}
	return checks;
}

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
			if (failures.length > 0) return { ok: false, anchorFailures: failures, checks };
			if (endLine < edit.start.line) return { ok: false, rangeError: `range ${edit.start.line}..${endLine} ends before it starts`, checks };
			return {
				ok: true,
				checks,
				op: { lo: edit.start.line - 1, hi: endLine, newLines: edit.op === "delete" ? [] : edit.body },
			};
		}
		case "insert_after":
		case "insert_before": {
			const failure = verifyAnchor(lines, edit.anchor, "anchor", opIndex, edit.op, hashLen, radius);
			const checks = [checkedAnchor(edit, opIndex, "anchor", edit.anchor, failure)];
			if (failure) return { ok: false, anchorFailures: [failure], checks };
			const line = edit.anchor.line - (edit.op === "insert_before" ? 1 : 0);
			return { ok: true, checks, op: { lo: line, hi: line, newLines: edit.body } };
		}
		case "append":
			return { ok: true, checks: [], op: { lo: lines.length, hi: lines.length, newLines: edit.body } };
		case "prepend":
			return { ok: true, checks: [], op: { lo: 0, hi: 0, newLines: edit.body } };
	}
}


function hasInvalidBodyLine(edits: readonly Edit[]): boolean {
	return edits.some((edit) => "body" in edit && edit.body.some((line) => /[\r\n]/.test(line)));
}

/**
 * Apply edits to `text`. Anchors are verified against the current content; on
 * success `touchedLines` gives the 0-based indices of the new-file lines this
 * edit produced. On any anchor mismatch, all failures (with shifted recovery)
 * are collected and returned together — nothing is written. Every failure includes
 * per-input anchor checks; input rejection before hashing marks them not_checked.
 *
 * @param text        current full file text
 * @param edits       parsed edit operations
 * @param hashLen     hash length used to verify anchors (default 4)
 * @param shiftRadius ±line radius for shifted-anchor recovery (default 15; 0 disables rescue)
 */
export function applyEdits(text: string, edits: Edit[], hashLen = 4, shiftRadius = DEFAULT_SHIFT_RADIUS): ApplyResult {
	if (hasInvalidBodyLine(edits)) {
		return { ok: false, failure: { kind: "input", message: "INVALID_BODY: each body element must contain exactly one logical line.", checks: inputAnchorChecks(edits, "not_checked") } };
	}
	const lines = splitLines(text);
	const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
	const ending = detectLineEnding(text);

	const ops: SpanOp[] = [];
	const anchorFailures: AnchorFailure[] = [];
	const anchorChecks: AnchorCheck[] = [];
	let rangeError: string | null = null;

	for (let i = 0; i < edits.length; i++) {
		const t = translateEdit(edits[i], i, lines, hashLen, shiftRadius);
		anchorChecks.push(...t.checks);
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
		return { ok: false, failure: { kind: "anchor", failures: anchorFailures, checks: anchorChecks } };
	}
	if (rangeError !== null) {
		return { ok: false, failure: { kind: "range", message: rangeError, checks: anchorChecks } };
	}

	const sorted = [...ops].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
	const conflict = findSortedRangeConflict(sorted.map((op) => [op.lo, op.hi]));
	if (conflict !== undefined) {
		return {
			ok: false,
			failure: {
				kind: "range",
				message: `overlapping edits near line ${sorted[conflict].lo + 1}; issue one edit per range`,
				checks: anchorChecks,
			},
		};
	}

	// Mixed line endings: each line carries the separator that FOLLOWED it in
	// the original (its gap), so surviving lines keep theirs byte for byte. New
	// gaps borrow the removed block's separators positionally — the last new
	// line inherits the block's trailing gap, leaving the boundary to the next
	// surviving line unchanged; gaps past the removed block's length (or in a
	// pure insertion) fall back to the file's customary ending.
	const separators = text.match(/\r?\n/g) ?? [];
	const separator = ending === "crlf" ? "\r\n" : "\n";
	// Verify legacy anchors above before separating the file BOM from movable line content.
	let result = lines.map((content, i) => ({ content: bom && i === 0 ? content.slice(1) : content, separator: separators[i] ?? "" }));
	for (const op of [...sorted].sort((a, b) => b.lo - a.lo)) {
		const removed = result.slice(op.lo, op.hi);
		const inserted = op.newLines.map((content, i) => ({
			// A copied first-line BOM denotes the existing file header, not a second BOM.
			content: bom && op.lo === 0 && i === 0 && content.startsWith(bom) ? content.slice(1) : content,
			separator: i === op.newLines.length - 1 && removed.length > 0
				? removed[removed.length - 1].separator
				: removed[i]?.separator || separator,
		}));
		result.splice(op.lo, op.hi - op.lo, ...inserted);
	}
	const finalNewline = hasFinalNewline(text);
	const newText = bom + result.map(({ content, separator: current }, i) =>
		content + (i < result.length - 1 || finalNewline ? current || separator : ""),
	).join("");
	if (newText === text) {
		return {
			ok: false,
			failure: {
				kind: "noop",
				message: "edit parsed and applied cleanly but produced no change; body is byte-identical — the bug is elsewhere, re-read first",
				checks: anchorChecks,
			},
		};
	}

	// touchedLines: new-file indices worth re-anchoring — each produced line,
	// and for a pure delete the line that shifted into the gap (so the model
	// gets a fresh anchor for the shifted region).
	const touched: number[] = [];
	const contextLines = new Set<number>();
	let delta = 0;
	for (const op of sorted) {
		const newLo = op.lo + delta;
		if (op.newLines.length > 0) {
			for (let i = 0; i < op.newLines.length; i++) {
				touched.push(newLo + i);
				// An adjacent replacement may supply the deletion successor itself.
				contextLines.delete(newLo + i);
			}
		} else if (newLo < result.length) {
			touched.push(newLo);
			contextLines.add(newLo);
		}
		delta += op.newLines.length - (op.hi - op.lo);
	}

	return { ok: true, text: newText, changed: true, touchedLines: touched, contextLines: [...contextLines] };
}

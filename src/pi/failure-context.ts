import { computeLineHash } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import type { AnchorFailure } from "../core/types.ts";

const CONTEXT_RADIUS = 3;
const MAX_CONTEXT_ROWS = 40;
const MAX_CONTEXT_BYTES = 16 * 1024;

type Interval = { lo: number; hi: number };
type ContextRow = { line: number; text: string };

function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = intervals.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
	const merged: Interval[] = [];
	for (const interval of sorted) {
		const previous = merged.at(-1);
		if (previous && interval.lo <= previous.hi + 1) previous.hi = Math.max(previous.hi, interval.hi);
		else merged.push({ ...interval });
	}
	return merged;
}

function shownIntervals(rows: readonly ContextRow[]): Interval[] {
	const intervals: Interval[] = [];
	for (const row of rows) {
		const previous = intervals.at(-1);
		if (previous && row.line === previous.hi + 1) previous.hi = row.line;
		else intervals.push({ lo: row.line, hi: row.line });
	}
	return intervals;
}

/**
 * Format bounded current-file anchors for unrecoverable anchor failures.
 * @internal Used by the edit tool and focused tests; performs no I/O.
 */
export function formatFailureContext(
	currentText: string,
	failures: readonly AnchorFailure[],
	hashLen: number,
): string {
	const unresolved = failures.filter((failure) => failure.recovery.kind === "none");
	if (unresolved.length === 0) return "";

	const lines = splitLines(currentText);
	const heading = [
		"Current-file context from the snapshot used for this check:",
		"Window: +/-3 lines around each clamped unresolved anchor.",
		"Limits: 40 rows; 16384 UTF-8 bytes of anchored row text.",
	];
	if (lines.length === 0) {
		return `\n${heading.join("\n")}\nThe file is empty in the validation snapshot; no context anchors are available.`;
	}

	const windows = mergeIntervals(unresolved.map((failure) => {
		const center = Math.min(lines.length, Math.max(1, failure.cited.line));
		return { lo: Math.max(1, center - CONTEXT_RADIUS), hi: Math.min(lines.length, center + CONTEXT_RADIUS) };
	}));
	const total = windows.reduce((sum, window) => sum + window.hi - window.lo + 1, 0);
	const rows: ContextRow[] = [];
	let bytes = 0;
	let truncatedBy: "row limit" | "byte limit" | undefined;

	outer: for (const window of windows) {
		for (let line = window.lo; line <= window.hi; line++) {
			if (rows.length >= MAX_CONTEXT_ROWS) {
				truncatedBy = "row limit";
				break outer;
			}
			const content = lines[line - 1];
			const text = `${line}#${computeLineHash(line, content, hashLen)}│${content}`;
			const rowBytes = Buffer.byteLength(`${text}\n`, "utf8");
			if (bytes + rowBytes > MAX_CONTEXT_BYTES) {
				truncatedBy = "byte limit";
				break outer;
			}
			rows.push({ line, text });
			bytes += rowBytes;
		}
	}

	const body: string[] = [...heading];
	if (rows.length === 0) {
		body.push("No context row fits the byte budget. Use read or grep for additional context.");
	} else {
		let index = 0;
		for (const interval of shownIntervals(rows)) {
			body.push(`@@ lines ${interval.lo}-${interval.hi} @@`);
			while (index < rows.length && rows[index].line <= interval.hi) body.push(rows[index++].text);
		}
	}
	const omitted = total - rows.length;
	body.push(`Context rows: ${rows.length}/${total}; ${omitted} omitted.`);
	if (truncatedBy) body.push(`Context truncated: ${truncatedBy}. Lowest-line rows were kept first.`);
	body.push("Re-evaluate the edit against these lines; do not blindly replace the old anchor.");
	body.push("Use read or grep if the relevant lines are omitted or more context is needed.");
	return `\n${body.join("\n")}`;
}

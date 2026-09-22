import type { AnchorFormatter } from "./anchor-format.ts";
import { splitLines } from "../core/lines.ts";
import type { AnchorFailure } from "../core/types.ts";

const CONTEXT_RADIUS = 3;
const MAX_CONTEXT_ROWS = 40;
const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_RECOVERY_CANDIDATE_BYTES = 4 * 1024;

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

function collectContextRows(
	lines: readonly string[],
	centers: readonly number[],
	anchors: AnchorFormatter,
	candidateLines?: ReadonlySet<number>,
) {
	const windows = mergeIntervals(centers.map((center) => {
		const line = Math.min(lines.length, Math.max(1, center));
		return { lo: Math.max(1, line - CONTEXT_RADIUS), hi: Math.min(lines.length, line + CONTEXT_RADIUS) };
	}));
	const total = windows.reduce((sum, window) => sum + window.hi - window.lo + 1, 0);
	const rows: ContextRow[] = [];
	let bytes = 0;
	let truncatedBy: "row limit" | "byte limit" | "candidate row limit" | undefined;

	outer: for (const window of windows) {
		for (let line = window.lo; line <= window.hi; line++) {
			if (rows.length >= MAX_CONTEXT_ROWS) {
				truncatedBy = "row limit";
				break outer;
			}
			const content = lines[line - 1];
			const text = anchors.row(line, content);
			const rowBytes = Buffer.byteLength(text, "utf8");
			// Neighborhoods must not bypass the standalone candidate's complete-row limit.
			if (candidateLines?.has(line) && rowBytes > MAX_RECOVERY_CANDIDATE_BYTES) {
				truncatedBy = "candidate row limit";
				break outer;
			}
			if (bytes + rowBytes + 1 > MAX_CONTEXT_BYTES) {
				truncatedBy = "byte limit";
				break outer;
			}
			rows.push({ line, text });
			bytes += rowBytes + 1;
		}
	}
	return { rows, total, truncatedBy };
}

function formatContextRows(rows: readonly ContextRow[], label: string): string[] {
	const body: string[] = [];
	let index = 0;
	for (const interval of shownIntervals(rows)) {
		body.push(`@@ ${label}lines ${interval.lo}-${interval.hi} @@`);
		while (index < rows.length && rows[index].line <= interval.hi) body.push(rows[index++].text);
	}
	return body;
}

/**
 * Format bounded current-file anchors for unrecoverable anchor failures.
 * @internal Used by the edit tool and focused tests; performs no I/O.
 */
export function formatFailureContext(
	currentText: string,
	failures: readonly AnchorFailure[],
	anchors: AnchorFormatter,
): string {
	const unresolved = failures.filter((failure) => failure.recovery.kind === "none");
	if (unresolved.length === 0) return "";

	const lines = splitLines(currentText);
	const heading = ["Current-file context (+/-3; validation snapshot):"];
	if (lines.length === 0) {
		return `\n${heading.join("\n")}\nThe file is empty in the validation snapshot; no context anchors are available.`;
	}
	const { rows, total, truncatedBy } = collectContextRows(lines, unresolved.map((failure) => failure.cited.line), anchors);
	const body: string[] = [...heading];
	if (rows.length === 0) {
		body.push("No context row fits the byte budget.");
	} else {
		body.push(...formatContextRows(rows, ""));
	}
	if (truncatedBy) {
		body.push(`Context rows: ${rows.length}/${total}; ${total - rows.length} omitted.`);
		body.push(`Context truncated: ${truncatedBy} (40 rows/16384 bytes; lowest lines first).`);
	}
	return `\n${body.join("\n")}`;
}

/**
 * Format observation rows around unique candidates and report the rows actually shown.
 * @internal Performs no I/O; the edit diagnostic uses shownLines to avoid repeating content.
 */
export function formatUniqueCandidateNeighborhoods(
	currentText: string,
	failures: readonly AnchorFailure[],
	anchors: AnchorFormatter,
): { text: string; shownLines: ReadonlySet<number> } {
	const centers = failures.flatMap((failure) => failure.recovery.kind === "found" ? [failure.recovery.newLine] : []);
	if (centers.length === 0) return { text: "", shownLines: new Set() };

	const lines = splitLines(currentText);
	const { rows, total, truncatedBy } = collectContextRows(lines, centers, anchors, new Set(centers));
	const body = ["Unique-candidate neighborhoods (+/-3; observation only):"];
	if (rows.length === 0) {
		body.push("No complete neighborhood row fits the limits.");
	} else {
		body.push(...formatContextRows(rows, "candidate-neighborhood "));
	}
	if (truncatedBy) {
		body.push(`Candidate-neighborhood rows: ${rows.length}/${total}; ${total - rows.length} omitted.`);
		body.push(`Candidate neighborhoods truncated: ${truncatedBy} (40 rows/16384 bytes; candidate row 4096 bytes; lowest lines first).`);
	}
	return { text: `\n${body.join("\n")}`, shownLines: new Set(rows.map((row) => row.line)) };
}

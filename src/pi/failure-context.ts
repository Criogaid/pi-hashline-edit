import type { AnchorFormatter } from "./anchor-format.ts";
import { splitLines } from "../core/lines.ts";
import type { AnchorFailure } from "../core/types.ts";
import { mergeRanges } from "../core/ranges.ts";

const CONTEXT_RADIUS = 3;
const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_RECOVERY_CANDIDATE_BYTES = 4 * 1024;
export const MAX_AMBIGUOUS_CANDIDATES = 8;

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
	const windows = mergeRanges(centers.map((center) => {
		const line = Math.min(lines.length, Math.max(1, center));
		return [Math.max(1, line - CONTEXT_RADIUS), Math.min(lines.length, line + CONTEXT_RADIUS) + 1];
	}));
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
			if (bytes + rowBytes + 1 > MAX_CONTEXT_BYTES) {
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
	const centers = failures.flatMap((failure) => failure.recovery.kind === "ambiguous"
		? failure.recovery.candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(candidate => candidate.line) : []);
	if (centers.length === 0) return { text: "", shownLines: new Set() };

	const lines = splitLines(currentText);
	const candidateLines = new Set(centers);
	for (const failure of failures) {
		if (failure.recovery.kind === "found") candidateLines.add(failure.recovery.newLine);
	}
	const { rows, total, truncatedBy } = collectContextRows(lines, centers, anchors, candidateLines);
	const body = ["Ambiguous-candidate neighborhoods (+/-3; observation only):"];
	if (rows.length === 0) {
		body.push("No complete neighborhood row fits the limits.");
	} else {
		body.push(...formatContextRows(rows));
	}
	if (truncatedBy) {
		body.push(`Candidate-neighborhood rows: ${rows.length}/${total}; ${total - rows.length} omitted.`);
		body.push(`Candidate neighborhoods truncated: ${truncatedBy} (16384 bytes; candidate row 4096 bytes; lowest lines first).`);
	}
	return { text: `\n${body.join("\n")}`, shownLines: new Set(rows.map((row) => row.line)) };
}

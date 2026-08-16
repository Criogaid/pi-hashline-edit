/**
 * Shared helpers for the hashline-aware tool renderers.
 *
 * The model-facing `content` text uses the `LINE#HASH│content` anchor format so
 * an anchor can be copied straight into an edit op. The user-facing TUI
 * renderers (read, grep) strip that prefix back to a clean `   N: content` form.
 * Parsing the anchor format in one place keeps read and grep in sync.
 *
 * @module pi-hashline-edit/pi
 */

import { renderDiff } from "@earendil-works/pi-coding-agent";

const HASHLINE_RE = /^(\d+)#[A-Za-z0-9]+│(.*)$/;

export interface HashlineRow {
	/** Line number as written in the anchor (string form). */
	lineNo: string;
	/** Line content with the `LINE#HASH│` prefix removed. */
	content: string;
}

/**
 * Parse a `LINE#HASH│content` anchor line.
 *
 * @returns the row, or `null` for non-anchor lines (headers, notices, free
 *   text) so callers can fall through to their own formatting.
 */
export function parseHashline(line: string): HashlineRow | null {
	const m = line.match(HASHLINE_RE);
	return m ? { lineNo: m[1], content: m[2] } : null;
}

/** Max diff lines shown when a result is rendered collapsed. */
const MAX_COLLAPSED_DIFF_LINES = 24;

/**
 * Render a pi-format diff (`+N`/`-N`/` N` content) for the TUI, reusing pi's
 * built-in renderer: semantic diff colors plus intra-line (word-level) change
 * highlighting on single-line modifications. When not expanded, collapse to the
 * first 24 rendered lines with an overflow marker — truncating after rendering
 * keeps `-`/`+` pairs intact so the intra-line highlight never dangles.
 */
export function renderDiffPreview(diff: string, expanded: boolean, theme: any): string {
	const rendered = renderDiff(diff);
	if (expanded) return rendered;
	const allLines = rendered.split("\n");
	const more =
		allLines.length > MAX_COLLAPSED_DIFF_LINES
			? `\n${theme.fg("dim", `… (${allLines.length - MAX_COLLAPSED_DIFF_LINES} more)`)}`
			: "";
	return allLines.slice(0, MAX_COLLAPSED_DIFF_LINES).join("\n") + more;
}

/** Added/removed line counts of a pi-format diff string (`+N`/`-N` leading char). */
export interface DiffCounts {
	added: number;
	removed: number;
}

/** Count added/removed lines in a pi-format diff (`+N content` / `-N content` / ` N content`). */
export function countDiffLines(diff: string): DiffCounts {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Format `+N -N` with the theme's diff colors for the tool call header. */
export function formatDiffCounts(counts: DiffCounts, theme: any): string {
	return ` ${theme.fg("toolDiffAdded", `+${counts.added}`)} ${theme.fg("toolDiffRemoved", `-${counts.removed}`)}`;
}

/**
 * Stash per-call diff counts into the row-local render state and refresh the
 * call header component in place — pi's own edit-tool pattern (renderResult
 * mutates the component stashed by renderCall; it never re-runs the renderer).
 *
 * `updateDisplay` runs renderCall before renderResult in every pass, so later
 * passes (expand/collapse, result updates) rebuild the header from
 * `state.diffCounts`; the in-place refresh covers the first result render,
 * where renderCall ran before the counts existed. renderResult cannot find the
 * header via `lastComponent` — there it is the *result* component — so
 * renderCall stashes it (e.g. `state.callText`).
 *
 * MUST NOT call `context.invalidate()`: it re-enters `updateDisplay`
 * synchronously (not re-entrant) and the outer pass then re-adds the result
 * component after the nested one — the diff renders twice.
 */
export function publishDiffCounts(
	diff: string | undefined,
	context: any,
	refreshHeader: (counts: DiffCounts) => void,
): void {
	if (!diff || !context?.state) return;
	const counts = countDiffLines(diff);
	const prev: DiffCounts | undefined = context.state.diffCounts;
	context.state.diffCounts = counts;
	if (!prev || prev.added !== counts.added || prev.removed !== counts.removed) refreshHeader(counts);
}

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

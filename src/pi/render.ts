/**
 * Shared anchor-parsing helper for the hashline-aware tool renderers.
 *
 * The model-facing `content` text uses the `LINE#HASH│content` anchor format so
 * an anchor can be copied straight into an edit op. The user-facing TUI
 * renderers (read, grep) strip that prefix back to a clean `   N: content` form.
 * Parsing the anchor format in one place keeps read and grep in sync.
 *
 * @module pi-hashline-edit/pi
 */

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

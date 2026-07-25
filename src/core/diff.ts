/**
 * Ops-based unified diff preview.
 *
 * Each SpanOp produces one hunk; the `@@` line numbers are based on the
 * original file (each op's own original position), so the content is accurate.
 * This is a Phase 1 approximation; if precise multi-op line numbers are needed,
 * LCS can replace it later.
 *
 * @module pi-hashline-edit/core
 */

interface SpanOpLike {
	lo: number;
	hi: number;
	newLines: string[];
}

/**
 * Build a unified diff.
 *
 * @param path     file path (for the diff header)
 * @param oldLines original line array before applying
 * @param ops      line-level operations applied
 */
export function buildDiff(path: string, oldLines: readonly string[], ops: readonly SpanOpLike[]): string {
	if (ops.length === 0) return "";
	const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
	for (const op of ops) {
		const oldCount = op.hi - op.lo;
		const oldStart = oldCount === 0 ? op.lo : op.lo + 1; // zero-width (insertion point) uses lo, following the unified-diff "after line N" convention
		const newCount = op.newLines.length;
		const newStart = op.lo + 1;
		// single-line hunks omit the count, following the unified-diff convention
		const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
		const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
		out.push(`@@ -${oldRange} +${newRange} @@`);
		for (let i = op.lo; i < op.hi; i++) out.push(`-${oldLines[i]}`);
		for (const nl of op.newLines) out.push(`+${nl}`);
	}
	return out.join("\n") + "\n";
}

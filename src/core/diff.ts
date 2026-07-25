/**
 * 基于 ops 的 unified diff 预览。
 *
 * 每个 SpanOp 生成一个 hunk，`@@` 行号基于原始文件（多 op 时各自的原始位置），
 * 内容准确。这是 Phase 1 的近似实现；如需精确的多 op 行号可后续换 LCS。
 *
 * @module pi-hashline-edit/core
 */

interface SpanOpLike {
	lo: number;
	hi: number;
	newLines: string[];
}

/**
 * 生成 unified diff。
 *
 * @param path     文件路径（用于 diff 头）
 * @param oldLines 应用前的原始行数组
 * @param ops      已应用的行级操作
 */
export function buildDiff(path: string, oldLines: readonly string[], ops: readonly SpanOpLike[]): string {
	if (ops.length === 0) return "";
	const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
	for (const op of ops) {
		const oldCount = op.hi - op.lo;
		const oldStart = oldCount === 0 ? op.lo : op.lo + 1; // 零宽（插入点）用 lo，符合 unified-diff "after line N" 惯例
		const newCount = op.newLines.length;
		const newStart = op.lo + 1;
		// 单行 hunk 省略计数，符合 unified-diff 惯例
		const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
		const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
		out.push(`@@ -${oldRange} +${newRange} @@`);
		for (let i = op.lo; i < op.hi; i++) out.push(`-${oldLines[i]}`);
		for (const nl of op.newLines) out.push(`+${nl}`);
	}
	return out.join("\n") + "\n";
}

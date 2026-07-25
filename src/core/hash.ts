/**
 * 行级 context-aware hash。
 *
 * 每行的 hash 把「上一行 + 本行 + 下一行」拼起来一起算，使内容相同的行
 * （空行、`}`、`return`）因邻居不同而 hash 不同，文件内碰撞实际接近 0。
 * 残余碰撞由 {@link hashFileLines} 自动扩展长度解决（per-file 无碰撞保证）。
 *
 * @module pi-hashline-edit/core
 */

/** Crockford base32 字符表（去 I/L/O/U，避免易混字符）。正好 32 个。 */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * FNV-1a 32-bit。稳定（同一输入永远同一输出）、分布均匀、非加密用途。
 * 用 `Math.imul` 保证 32-bit 整数乘法在 JS 下正确。
 */
function fnv1a32(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** 把 32-bit 整数编码为指定长度的 base32 字符串。 */
function toBase32(n: number, len: number): string {
	let s = "";
	for (let i = 0; i < len; i++) {
		s = BASE32[n & 31] + s;
		n = Math.floor(n / 32);
	}
	return s;
}

/**
 * 计算单行的 context-aware hash。
 *
 * @param prev 上一行内容（首行传 `""`）
 * @param cur  本行内容
 * @param next 下一行内容（末行传 `""`）
 * @param len  hash 长度（默认 4，20 bits ≈ 100 万值）
 */
export function computeLineHash(prev: string, cur: string, next: string, len = 4): string {
	const h = fnv1a32(`${prev}\n${cur}\n${next}`);
	return toBase32(h, len);
}

/** 给每行算 raw hash（不处理碰撞）。 */
function rawHashes(lines: readonly string[], len: number): string[] {
	return lines.map((line, i) =>
		computeLineHash(lines[i - 1] ?? "", line, lines[i + 1] ?? "", len),
	);
}

/** 找出出现 >1 次的 hash 值。 */
function duplicatedHashes(hashes: readonly string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
	return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([h]) => h));
}

/** 兜底：用序号后缀强制唯一（context-aware 下理论不可达）。 */
function forceUnique(hashes: string[]): string[] {
	const seen = new Map<string, number>();
	return hashes.map((h) => {
		const c = seen.get(h) ?? 0;
		seen.set(h, c + 1);
		return c === 0 ? h : `${h}${c}`;
	});
}

/**
 * 给整个文件的每行算 hash，并解决文件内碰撞：
 * 碰撞的行自动用更长 len 重算，直到文件内唯一（per-file 无碰撞保证）。
 *
 * 设计依据：context-aware 已使碰撞概率接近 0；此处扩展是防御性兜底，
 * 保证 apply 永远不会因 hash 歧义而误定位。
 */
export function hashFileLines(lines: readonly string[], len = 4): string[] {
	if (lines.length === 0) return [];
	let hashes = rawHashes(lines, len);
	for (let curLen = len; curLen <= len + 4; curLen++) {
		const dups = duplicatedHashes(hashes);
		if (dups.size === 0) return hashes;
		hashes = hashes.map((h, i) =>
			dups.has(h)
				? computeLineHash(lines[i - 1] ?? "", lines[i] ?? "", lines[i + 1] ?? "", curLen + 1)
				: h,
		);
	}
	return forceUnique(hashes);
}

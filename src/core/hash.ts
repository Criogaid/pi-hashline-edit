/**
 * Per-line context-aware hash.
 *
 * Each line's hash is computed by concatenating "previous line + this line +
 * next line", so identical content lines (blank lines, `}`, `return`) get
 * different hashes due to different neighbors, making in-file collisions
 * effectively zero. Residual collisions are resolved by {@link hashFileLines}
 * via automatic length extension (per-file zero-collision guarantee).
 *
 * @module pi-hashline-edit/core
 */

/** Crockford base32 alphabet (without I/L/O/U to avoid ambiguous characters). Exactly 32 characters. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * FNV-1a 32-bit. Stable (same input always yields the same output), evenly
 * distributed, non-cryptographic. Uses `Math.imul` for correct 32-bit integer
 * multiplication under JS.
 */
function fnv1a32(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Encode a 32-bit integer into a base32 string of the given length. */
function toBase32(n: number, len: number): string {
	let s = "";
	for (let i = 0; i < len; i++) {
		s = BASE32[n & 31] + s;
		n = Math.floor(n / 32);
	}
	return s;
}

/**
 * Compute the context-aware hash of a single line.
 *
 * @param prev previous line content (`""` for the first line)
 * @param cur  this line's content
 * @param next next line content (`""` for the last line)
 * @param len  hash length (default 4, 20 bits ≈ 1M values)
 */
export function computeLineHash(prev: string, cur: string, next: string, len = 4): string {
	const h = fnv1a32(`${prev}\n${cur}\n${next}`);
	return toBase32(h, len);
}

/** Compute raw per-line hashes (no collision handling). */
function rawHashes(lines: readonly string[], len: number): string[] {
	return lines.map((line, i) =>
		computeLineHash(lines[i - 1] ?? "", line, lines[i + 1] ?? "", len),
	);
}

/** Find hash values that appear more than once. */
function duplicatedHashes(hashes: readonly string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
	return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([h]) => h));
}

/** Fallback: force uniqueness with an index suffix (theoretically unreachable under context-aware hashing). */
function forceUnique(hashes: string[]): string[] {
	const seen = new Map<string, number>();
	return hashes.map((h) => {
		const c = seen.get(h) ?? 0;
		seen.set(h, c + 1);
		return c === 0 ? h : `${h}${c}`;
	});
}

/**
 * Compute per-line hashes for the whole file and resolve in-file collisions:
 * colliding lines are recomputed with a longer len until unique within the file
 * (per-file zero-collision guarantee).
 *
 * Design rationale: context-aware hashing already drives the collision
 * probability near zero; this extension is a defensive fallback guaranteeing
 * apply never mislocates due to hash ambiguity.
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

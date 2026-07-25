/**
 * Per-line content hash.
 *
 * The hash mixes the 1-based line number into the line content, so every line
 * gets a unique hash by construction — line numbers are unique, therefore no
 * in-file collision is possible, and no length extension / fallback is ever
 * needed.
 *
 * Why line + content (not content alone, not content + neighbors):
 *
 * - The line number is the address; the hash is a checksum that the line at
 *   that address is still what was read. Mixing the number in makes the hash a
 *   pure fingerprint of (position, content): it changes only when the line's
 *   own content changes, never when a neighbor changes. (A neighbor-aware hash
 *   would change an unchanged line's hash when an adjacent line is edited — a
 *   spurious dependency with no benefit under this design's position-fixed
 *   apply.)
 * - Content alone would leave identical lines (blank lines, `}`) sharing a
 *   hash; mixing the line number disambiguates them for free.
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
 * Compute the hash of a single line from its 1-based line number and content.
 *
 * @param line    1-based line number
 * @param content the line's content (no line terminator)
 * @param len     hash length (default 4, 20 bits ≈ 1M values)
 */
export function computeLineHash(line: number, content: string, len = 4): string {
	return toBase32(fnv1a32(`${line}\n${content}`), len);
}

/**
 * Compute per-line hashes for a file. Unique by construction — the 1-based line
 * number is part of each hash, so two identical content lines always differ.
 */
export function hashFileLines(lines: readonly string[], len = 4): string[] {
	return lines.map((content, i) => computeLineHash(i + 1, content, len));
}

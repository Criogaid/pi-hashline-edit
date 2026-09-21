/**
 * Per-line content hash.
 *
 * The hash mixes the 1-based line number into the line content. It is a compact
 * checksum of (position, content), not a unique identifier: truncation and the
 * 32-bit source hash permit collisions.
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
 * - Content alone would make identical lines (blank lines, `}`) share the same
 *   checksum systematically; mixing the line number avoids that common case.
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

/** Compute compact per-line checksums; callers must treat collisions as possible. */
export function hashFileLines(lines: readonly string[], len = 4): string[] {
	return lines.map((content, i) => computeLineHash(i + 1, content, len));
}

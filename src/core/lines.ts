/**
 * Line text helpers: split/join with CRLF normalization, line-ending detection
 * and final-newline fidelity.
 *
 * CRLF: splitLines normalizes `\r\n` boundaries while preserving standalone
 * `\r` content. detectLineEnding records whether the file uses CRLF at all
 * (any `\r\n` counts) so new boundaries added by an edit can use the file's
 * customary ending.
 *
 * Final newline: splitLines discards whether the input ended with a terminator
 * (a trailing newline terminates the last line, it does not create one).
 * hasFinalNewline recovers that state so a file that lacked a final newline
 * does not silently gain one — editing reassembles per-line separators and
 * must suppress the last line's terminator accordingly.
 *
 * @module pi-hashline-edit/core
 */

import type { LineEnding } from "./types.ts";

/** Normalize CRLF boundaries to LF; standalone CR remains content. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/** Raw separators in logical-line order, shared by both mutation applicators. */
export function lineSeparators(text: string): string[] {
	return text.match(/\r?\n/g) ?? [];
}

/** New internal gaps reuse the corresponding old gap, then the last gap or file style. */
export function replacementSeparator(separators: readonly string[], index: number, fallback: string): string {
	return separators[index] || separators[separators.length - 1] || fallback;
}

/** Restore a logical replacement without normalizing it a second time. */
export function restoreLineEndings(logical: string, original: string, fallback: string): string {
	const separators = lineSeparators(original);
	let index = 0;
	return logical.replace(/\n/g, () => replacementSeparator(separators, index++, fallback));
}

/** Build an LF matching view with UTF-16 boundary offsets back into the original text. */
export function createLfTextView(source: string) {
	const removed: number[] = [];
	for (const match of source.matchAll(/\r\n/g)) removed.push(match.index! - removed.length);
	return {
		text: normalizeLineEndings(source),
		sourceOffset(offset: number): number {
			// Count removed CRs strictly before this boundary: a newline starts at its original CR.
			let lo = 0;
			let hi = removed.length;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				if (removed[mid] < offset) lo = mid + 1;
				else hi = mid;
			}
			return offset + lo;
		},
	};
}

/**
 * Split text into lines, normalizing CRLF boundaries and preserving standalone `\r`.
 *
 * Convention: a trailing newline is treated as the terminator of the last line,
 * not as producing an extra empty trailing line.
 * - `"a\nb\n"` → `["a", "b"]`
 * - `"a\r\nb\r\n"` → `["a", "b"]` (`\r` stripped)
 * - `"a\n\n"` → `["a", ""]`
 * - `""` → `[]`
 */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const normalized = normalizeLineEndings(text);
	return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

/** Whether the text uses CRLF at all (any `\r\n` counts; mixed files report "crlf"). */
export function detectLineEnding(text: string): LineEnding {
	return text.includes("\r\n") ? "crlf" : "lf";
}

/**
 * Whether the text ends with a line terminator — the state splitLines discards
 * and edit application needs in order to reproduce a document byte for byte.
 *
 * The empty string has no lines and no terminator; it reports `true` so that
 * rejoining its (also empty) line array — which yields `""` either way —
 * round-trips.
 */
export function hasFinalNewline(text: string): boolean {
	return text === "" || text.endsWith("\n");
}

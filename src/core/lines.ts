/**
 * Line text helpers: split/join with CRLF normalization, line-ending detection
 * and final-newline fidelity.
 *
 * CRLF: splitLines strips the trailing `\r` from each line (hashes are based on
 * clean lines, matching the `\r`-free content the model copies from the
 * display); detectLineEnding records whether the file uses CRLF at all (any
 * `\r\n` counts) so new boundaries added by an edit can use the file's
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

/**
 * Split text into lines, stripping the trailing `\r` of each line (CRLF
 * normalization, so hashes are based on clean lines).
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
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	return normalized.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
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

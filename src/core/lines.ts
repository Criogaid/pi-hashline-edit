/**
 * Line text helpers: split/join with CRLF normalization, line-ending detection
 * and final-newline fidelity.
 *
 * CRLF: splitLines strips the trailing `\r` from each line (hashes are based on
 * clean lines, matching the `\r`-free content the model copies from the
 * display); detectLineEnding records the original ending so joinLines can
 * restore it — guaranteeing a CRLF file keeps its endings after edit.
 *
 * Final newline: splitLines discards whether the input ended with a terminator
 * (a trailing newline terminates the last line, it does not create one).
 * joinLines therefore takes that state as an argument rather than assuming it —
 * a file that lacked a final newline must not silently gain one.
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

/** Detect the dominant line ending of the text (any `\r\n` counts as CRLF). */
export function detectLineEnding(text: string): LineEnding {
	return text.includes("\r\n") ? "crlf" : "lf";
}

/**
 * Whether the text ends with a line terminator — the state splitLines discards
 * and joinLines needs in order to reproduce a document byte for byte.
 *
 * The empty string has no lines and no terminator; it reports `true` so that
 * rejoining its (also empty) line array — which yields `""` either way —
 * round-trips.
 */
export function hasFinalNewline(text: string): boolean {
	return text === "" || text.endsWith("\n");
}

/**
 * Join a line array back into text, restoring the given line ending (default LF)
 * and final-newline state (default: terminates with a newline, the convention
 * for freshly created content).
 *
 * Reconstructing an *existing* file must pass `hasFinalNewline(originalText)` so
 * a missing terminator stays missing.
 */
export function joinLines(lines: readonly string[], ending: LineEnding = "lf", finalNewline = true): string {
	if (lines.length === 0) return "";
	const sep = ending === "crlf" ? "\r\n" : "\n";
	const body = lines.join(sep);
	return finalNewline ? body + sep : body;
}

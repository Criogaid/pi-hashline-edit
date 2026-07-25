/**
 * Line text helpers: split/join with CRLF normalization and line-ending
 * detection.
 *
 * CRLF: splitLines strips the trailing `\r` from each line (hashes are based on
 * clean lines, matching the `\r`-free content the model copies from the
 * display); detectLineEnding records the original ending so joinLines can
 * restore it — guaranteeing a CRLF file keeps its endings after edit.
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

/** Join a line array back into text, restoring the given line ending (default LF). Non-empty files end with a newline. */
export function joinLines(lines: readonly string[], ending: LineEnding = "lf"): string {
	if (lines.length === 0) return "";
	const sep = ending === "crlf" ? "\r\n" : "\n";
	return lines.join(sep) + sep;
}

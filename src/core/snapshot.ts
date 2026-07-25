/**
 * File snapshot and anchor verification.
 *
 * A snapshot records the original text + per-line hash at read time; at apply
 * time it verifies "current file == snapshot" (stale check) and that each
 * anchor's hash matches its line number (guards against the model
 * misremembering).
 *
 * CRLF: splitLines normalizes by stripping the trailing `\r` from each line
 * (hashes are based on clean lines, matching the `\r`-free content the model
 * copies from the display); createSnapshot records the original line ending,
 * and joinLines restores it per the recorded ending — guaranteeing a CRLF file
 * keeps its line endings after edit.
 *
 * @module pi-hashline-edit/core
 */

import { hashFileLines } from "./hash.ts";
import type { Anchor, FileSnapshot, LineEnding } from "./types.ts";

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

/** Create a snapshot for a file: record original text + line ending + per-line context-aware hash. */
export function createSnapshot(path: string, text: string, len = 4): FileSnapshot {
	const lines = splitLines(text);
	const lineHashes = hashFileLines(lines, len);
	return { path, lineHashes, text, hashLen: len, lineEnding: detectLineEnding(text) };
}

/** Anchor verification result. */
export type AnchorVerifyResult =
	| { readonly ok: true; readonly line: number }
	| {
			readonly ok: false;
			readonly error: "hash_not_found" | "line_mismatch" | "collision";
			/** Line number(s) where the hash actually appears (1-based). */
			readonly found?: readonly number[];
	  };

/**
 * Verify an anchor against the snapshot.
 *
 * - hash is unique and the line number matches → `ok`
 * - hash is unique but the line number differs → `line_mismatch` (`found` gives the real line number; drift, handled by the relocate middleware)
 * - hash appears at multiple lines → `collision` (`found` gives all positions)
 * - hash does not exist → `hash_not_found` (file changed, needs re-read)
 */
export function verifyAnchor(snapshot: FileSnapshot, anchor: Anchor): AnchorVerifyResult {
	const found: number[] = [];
	for (let i = 0; i < snapshot.lineHashes.length; i++) {
		if (snapshot.lineHashes[i] === anchor.hash) found.push(i + 1);
	}
	if (found.length === 0) return { ok: false, error: "hash_not_found" };
	if (found.length > 1) return { ok: false, error: "collision", found };
	if (found[0] !== anchor.line) return { ok: false, error: "line_mismatch", found };
	return { ok: true, line: anchor.line };
}

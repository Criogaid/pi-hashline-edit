/**
 * Override read: text files output "lineNo#hash│content"; non-text (images /
 * binary) and read errors delegate to the built-in read.
 *
 * Hashes are computed from the current content on the fly — nothing is stored.
 * The hash is `(line number, content)`, recomputed and checked at edit time, so
 * no snapshot is needed to verify an anchor later.
 *
 * @module pi-hashline-edit/pi
 */

import { createReadToolDefinition, getLanguageFromPath, highlightCode, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { decodeUtf8, hashFileLines } from "../core/index.ts";
import { hasFinalNewline, splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { parseHashline } from "./render.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

/**
 * Canonical absolute path: shared by read/edit/grep to resolve a file consistently.
 * Expands a leading `~` / `~/` to the user's home directory. (`~user` is not supported.)
 */
export function canonicalPath(cwd: string, p: string): string {
	return resolve(cwd, expandTilde(p));
}

/** Mirrors pi core's `normalizePath` tilde handling: expands `~` / `~/` (and `~\` on Windows), leaves `~user` untouched. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

/**
 * Render the expanded read body for the TUI: color the header, strip the
 * `LINE#HASH│` prefix from every anchor line to `   N: content`, and
 * syntax-highlight the code block by the file's language (falls back to a
 * single `toolOutput` color when the language is unknown or the highlight
 * line count diverges). Trailing notices (e.g. truncation) are shown in
 * `warning`.
 */
function renderReadBody(raw: string, path: string, theme: any): string {
	const lines = raw.split("\n");
	if (lines.length === 0) return "";
	const out: string[] = [];

	// Header: "<path> · <N> lines", optionally followed by " (from line <offset>)"
	// and/or " · no trailing newline".
	let bodyStart = 0;
	const h = lines[0].match(/^(.+?) · (\d+ lines(?: \(from line \d+\))?(?: · no trailing newline)?)$/);
	if (h) {
		out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
		bodyStart = 1;
	}

	// Collect anchor rows (full content); the first non-anchor line begins the tail.
	const lineNos: string[] = [];
	const codeContents: string[] = [];
	let tailStart = lines.length;
	for (let i = bodyStart; i < lines.length; i++) {
		const row = parseHashline(lines[i]);
		if (!row) {
			tailStart = i;
			break;
		}
		lineNos.push(row.lineNo);
		codeContents.push(row.content);
	}

	// Syntax-highlight the whole block so multi-line constructs stay correct.
	const detabbed = codeContents.map((l) => l.replace(/\t/g, "   "));
	const lang = getLanguageFromPath(path);
	let rendered: string[];
	if (lang) {
		const hl = highlightCode(detabbed.join("\n"), lang);
		// Guard against highlighters that reshape line count: fall back to plain.
		rendered = hl.length === detabbed.length ? hl : detabbed.map((l) => theme.fg("toolOutput", l));
	} else {
		rendered = detabbed.map((l) => theme.fg("toolOutput", l));
	}
	for (let i = 0; i < rendered.length && i < lineNos.length; i++) {
		out.push(theme.fg("dim", `   ${lineNos[i]}: `) + rendered[i]);
	}

	for (let i = tailStart; i < lines.length; i++) {
		out.push(theme.fg("warning", lines[i]));
	}
	return out.join("\n");
}

/** Build the read override (a ToolDefinition fragment for registerTool). */
export function makeReadOverride(cwd: string) {
	const builtin = createReadToolDefinition(cwd);

	return {
		name: "read" as const,
		label: "read",
		description:
			"Read file contents. Text files display per-line content hashes (LINE#HASH│content) for hashline-verified editing.",
		promptSnippet: "Read files with editable line anchors",
		promptGuidelines: [
			"Prefer read over shell output for files you intend to edit.",
		],
		parameters: builtin.parameters,
		renderShell: "default" as const,

		renderCall: builtin.renderCall,

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
			const content = result.content?.[0];
			if (context?.isError) {
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			// Collapsed (not expanded): show nothing — the call line carries the
			// title, matching the built-in read's fold behavior.
			if (!expanded) return new Text("", 0, 0);
			const raw = content?.type === "text" ? content.text : "";
			return new Text(renderReadBody(raw, String(context?.args?.path ?? ""), theme), 0, 0);
		},

		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx?: any) {
			// User cancelled → delegate to the built-in (builtin handles abort itself)
			if (signal?.aborted) return builtin.execute(toolCallId, params, signal, onUpdate, ctx);

			const absPath = canonicalPath(cwd, params.path as string);
			let buf: Buffer;
			try {
				buf = await readFile(absPath);
			} catch {
				// read error → delegate to the built-in (it has polished error messages)
				return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			}

			// binary/image detection (null byte) → delegate to the built-in (it uses file-type for images)
			if (buf.includes(0)) return builtin.execute(toolCallId, params, signal, onUpdate, ctx);

			const text = decodeUtf8(buf);
			const allLines = splitLines(text);
			const totalLines = allLines.length;
			const hashes = hashFileLines(allLines, getState().config.hashLen);

			// offset/limit
			const offset = (params.offset as number | undefined) ?? 1;
			const limit = (params.limit as number | undefined) ?? MAX_LINES;
			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(totalLines, startIdx + limit);

			const rows = allLines.slice(startIdx, endIdx).map((line, index) => `${startIdx + index + 1}#${hashes[startIdx + index]}│${line}`);
			const truncation = truncateHead(rows.join("\n"), { maxBytes: MAX_BYTES, maxLines: rows.length });

			const shownFrom = offset > 1 ? ` (from line ${offset})` : "";
			// A file whose last line carries no terminator is a byte-level fact that the
			// numbered rows cannot show; state it in the header, the one line the model
			// never copies into an edit `body`.
			const noFinalNewline = hasFinalNewline(text) ? "" : " · no trailing newline";
			const tail = truncation.firstLineExceedsLimit
				? `\n… (line ${offset} exceeds ${MAX_BYTES >> 10}KB; cannot return a complete anchor row)`
				: truncation.truncated ? `\n… (truncated at ${MAX_BYTES >> 10}KB; use offset/limit to read more)` : "";
			const header = `${params.path} · ${totalLines} lines${shownFrom}${noFinalNewline}\n`;
			const body = truncation.content;

			return {
				content: [{ type: "text" as const, text: header + body + tail }],
				details: truncation.truncated ? { truncation } : undefined,
			};
		},
	};
}

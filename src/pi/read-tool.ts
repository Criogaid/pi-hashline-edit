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

import { createReadTool, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
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

/** Offset/limit range suffix for the read call line, e.g. `:50-99` (mirrors pi core's read tool). */
function formatReadLineRange(args: any, theme: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : "";
	return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
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

	// Header: "<path> · <N> lines" optionally followed by " (from line <offset>)".
	let bodyStart = 0;
	const h = lines[0].match(/^(.+?) · (\d+ lines(?: \(from line \d+\))?)$/);
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
	const builtin = createReadTool(cwd);

	return {
		name: "read" as const,
		label: "read",
		description:
			"Read file contents. Text files display per-line content hashes (LINE#HASH│content) for hashline-verified editing.",
		promptSnippet: "Read files; each text line shows a content hash (LINE#HASH│content) anchoring it for edits",
		promptGuidelines: [
			'Text files display as `LINE#HASH│content` (e.g. `12#aF3│  return x`). The `#HASH` anchors each line for precise editing.',
			"Pass `path`; optionally `offset` (1-indexed start line) and `limit` (max lines). Prefer read over cat/sed for files you intend to edit.",
		],
		parameters: builtin.parameters,
		renderShell: "default" as const,

		renderCall(args: any, theme: any) {
			const pathDisplay = String(args?.path ?? "");
			let text = theme.fg("toolTitle", theme.bold("read")) + " " + theme.fg("accent", pathDisplay);
			const range = formatReadLineRange(args, theme);
			if (range) text += range;
			return new Text(text, 0, 0);
		},

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

		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any) {
			// Not enabled OR user cancelled → delegate to the built-in (builtin handles abort itself)
			if (!getState().config.enabled || signal?.aborted) return builtin.execute(toolCallId, params, signal, onUpdate);

			const absPath = canonicalPath(cwd, params.path as string);
			let buf: Buffer;
			try {
				buf = await readFile(absPath);
			} catch {
				// read error → delegate to the built-in (it has polished error messages)
				return builtin.execute(toolCallId, params, signal, onUpdate);
			}

			// binary/image detection (null byte) → delegate to the built-in (it uses file-type for images)
			if (buf.includes(0)) return builtin.execute(toolCallId, params, signal, onUpdate);

			const text = buf.toString("utf-8");
			const allLines = splitLines(text);
			const totalLines = allLines.length;
			const hashes = hashFileLines(allLines, getState().config.hashLen);

			// offset/limit
			const offset = (params.offset as number | undefined) ?? 1;
			const limit = (params.limit as number | undefined) ?? MAX_LINES;
			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(totalLines, startIdx + limit);

			const rows: string[] = [];
			let bytes = 0;
			let truncated = false;
			for (let i = startIdx; i < endIdx; i++) {
				const lineNo = i + 1;
				const row = `${lineNo}#${hashes[i]}│${allLines[i]}`;
				bytes += Buffer.byteLength(row, "utf-8");
				if (bytes > MAX_BYTES) {
					truncated = true;
					break;
				}
				rows.push(row);
			}

			const shownFrom = offset > 1 ? ` (from line ${offset})` : "";
			const tail = truncated ? `\n… (truncated at ${MAX_BYTES >> 10}KB; use offset/limit to read more)` : "";
			const header = `${params.path} · ${totalLines} lines${shownFrom}\n`;
			const body = rows.join("\n");

			return {
				content: [{ type: "text" as const, text: header + body + tail }],
				details: undefined,
			};
		},
	};
}

/**
 * Override read: recognized images and NUL-containing files delegate to Pi's
 * built-in read; valid UTF-8 text outputs "lineNo#hash│content".
 *
 * Hashes are computed from the current content on the fly — nothing is stored.
 * The hash is `(line number, content)`, recomputed and checked at edit time, so
 * no snapshot is needed to verify an anchor later.
 *
 * @module pi-hashline-edit/pi
 */

import {
	createReadToolDefinition, detectSupportedImageMimeTypeFromFile,
	getLanguageFromPath, highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { scanTextLines } from "./text-stream.ts";
import { createAnchorFormatter, displayCarriageReturns } from "./anchor-format.ts";
import { canonicalPath } from "./path.ts";
import { parseHashline, renderToolError } from "./render.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

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
			"Read file contents. Text files display per-line content hashes (LINE#HASH│content) in the shared LF view for hashline-verified editing. CRLF line boundaries display as LF; source-code escape sequences remain literal text.",
		promptSnippet: "Read files with editable line anchors",
		promptGuidelines: [
			"Prefer read over shell output for files you intend to edit.",
			"For targeted inspection of large files, pass offset and limit (e.g. limit: 50) to inspect only the relevant section and conserve context.",
		],
		parameters: builtin.parameters,
		renderShell: "default" as const,

		renderCall: builtin.renderCall,

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
			const content = result.content?.[0];
			if (context?.isError) return renderToolError(result, theme);
			// Collapsed (not expanded): show nothing — the call line carries the
			// title, matching the built-in read's fold behavior.
			if (!expanded) return new Text("", 0, 0);
			const raw = content?.type === "text" ? content.text : "";
			return new Text(renderReadBody(raw, String(context?.args?.path ?? ""), theme), 0, 0);
		},

		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx?: any) {
			// User cancelled → delegate to the built-in (builtin handles abort itself)
			if (signal?.aborted) return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			const anchors = createAnchorFormatter();

			const absPath = canonicalPath(cwd, params.path as string);
			try {
				if (await detectSupportedImageMimeTypeFromFile(absPath)) {
					return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
				}
			} catch {
				return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			}

			const offset = (params.offset as number | undefined) ?? 1;
			const limit = (params.limit as number | undefined) ?? MAX_LINES;
			const start = Math.max(1, offset);
			const end = start + limit;
			const rows: string[] = [];
			const crExpansion = Buffer.byteLength(displayCarriageReturns("\r")) - 1;
			let totalRows = 0;
			let totalBytes = 0;
			let outputBytes = 0;
			let truncated = false;
			let firstLineExceedsLimit = false;
			let stats: Awaited<ReturnType<typeof scanTextLines>>;
			try {
				stats = await scanTextLines(absPath,
					(number) => number >= start && number < end,
					(line) => {
						const rowBytes = line.byteLength + line.carriageReturns * crExpansion + Buffer.byteLength(anchors.row(line.number, ""));
						totalBytes += rowBytes + (totalRows++ > 0 ? 1 : 0);
						if (truncated) return;
						const nextBytes = outputBytes + rowBytes + (rows.length > 0 ? 1 : 0);
						if (nextBytes > MAX_BYTES) {
							truncated = true;
							firstLineExceedsLimit = rows.length === 0;
							return;
						}
						rows.push(anchors.row(line.number, line.text!));
						outputBytes = nextBytes;
					}, { signal, maxLineBytes: MAX_BYTES });
			} catch (error) {
				// Keep native filesystem diagnostics without retrying decoding or cancellation failures.
				if (!signal?.aborted && error instanceof Error && "code" in error) {
					return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
				}
				throw error;
			}
			if (stats.hasNul) return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			const truncation = {
				content: rows.join("\n"), truncated, truncatedBy: truncated ? "bytes" as const : null,
				totalLines: totalRows, totalBytes, outputLines: rows.length, outputBytes,
				lastLinePartial: false, firstLineExceedsLimit, maxLines: totalRows, maxBytes: MAX_BYTES,
			};

			const shownFrom = offset > 1 ? ` (from line ${offset})` : "";
			// A file whose last line carries no terminator is a byte-level fact that the
			// numbered rows cannot show; state it in the header, the one line the model
			// never copies into an edit `body`.
			const noFinalNewline = stats.finalNewline ? "" : " · no trailing newline";
			const tail = truncation.firstLineExceedsLimit
				? `\n… (line ${offset} exceeds ${MAX_BYTES >> 10}KB; cannot return a complete anchor row. Reducing limit cannot split a physical line; use bash to inspect it in chunks, or replace for a known literal/regex change)`
				: truncation.truncated ? `\n… (truncated at ${MAX_BYTES >> 10}KB; use offset/limit to read more)` : "";
			const header = `${params.path} · ${stats.totalLines} lines${shownFrom}${noFinalNewline}\n`;
			const body = truncation.content;

			return {
				content: [{ type: "text" as const, text: header + body + tail }],
				details: truncation.truncated ? { truncation } : undefined,
			};
		},
	};
}

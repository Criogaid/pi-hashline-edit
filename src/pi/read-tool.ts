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

import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";

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

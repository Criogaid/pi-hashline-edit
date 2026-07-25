/**
 * Override read: text files output "lineNo#hash│content" and record a snapshot;
 * non-text (images/binary) and read errors delegate to the built-in read, whose
 * renderer is inherited automatically.
 *
 * @module pi-hashline-edit/pi
 */

import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { splitLines } from "../core/snapshot.ts";
import { getState, recordSnapshot } from "./state.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

/** canonical path: shared by read/edit to keep the snapshot key consistent. */
export function canonicalPath(cwd: string, p: string): string {
	return resolve(cwd, p);
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

			// record a full-file snapshot (edit anchors are based on full-file line numbers)
			const snap = recordSnapshot(absPath, text);

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
				const row = `${lineNo}#${snap.lineHashes[i]}│${allLines[i]}`;
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

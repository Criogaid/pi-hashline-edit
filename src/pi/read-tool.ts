/**
 * Override read：文本文件输出「行号#hash│内容」并记录快照；
 * 非文本（图片/二进制）与读取错误透传内置 read，renderer 自动继承。
 *
 * @module pi-hashline-edit/pi
 */

import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { splitLines } from "../core/snapshot.ts";
import { getState, getSnapshot, recordSnapshot } from "./state.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

/** canonical path：read/edit 共用，保证 snapshot key 一致。 */
export function canonicalPath(cwd: string, p: string): string {
	return resolve(cwd, p);
}

/** 构造 read override（registerTool 的 ToolDefinition 片段）。 */
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
			// 未启用 → 完全透传内置
			// 未启用 或 用户已取消 → 透传内置（builtin 自行处理 abort）
			if (!getState().config.enabled || signal?.aborted) return builtin.execute(toolCallId, params, signal, onUpdate);

			const absPath = canonicalPath(cwd, params.path as string);
			let buf: Buffer;
			try {
				buf = await readFile(absPath);
			} catch {
				// 读取错误 → 透传内置（它有完善的错误信息）
				return builtin.execute(toolCallId, params, signal, onUpdate);
			}

			// 二进制/图片检测（null 字节）→ 透传内置（内置用 file-type 处理图片）
			if (buf.includes(0)) return builtin.execute(toolCallId, params, signal, onUpdate);

			const text = buf.toString("utf-8");
			const allLines = splitLines(text);
			const totalLines = allLines.length;

			// 记录全文快照（edit 锚基于全文行号）
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

/** 供 edit override 复用：取某 path 的已记录快照（按 canonical path）。 */
export function lookupSnapshot(cwd: string, p: string) {
	return getSnapshot(canonicalPath(cwd, p));
}

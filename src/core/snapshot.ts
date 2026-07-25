/**
 * 文件快照与锚校验。
 *
 * 快照在 read 时记录原文 + 每行 hash；apply 时校验「当前文件 == 快照」
 * （stale 检查）以及每个锚的 hash 与行号对得上（防模型记错）。
 *
 * CRLF：splitLines 归一化去掉每行尾的 \r（hash 基于干净行，与模型从显示中
 * 复制的无 \r 内容一致），createSnapshot 记录原行尾，joinLines 按记录的
 * 行尾恢复——保证 CRLF 文件 edit 后行尾不变。
 *
 * @module pi-hashline-edit/core
 */

import { hashFileLines } from "./hash.ts";
import type { Anchor, FileSnapshot, LineEnding } from "./types.ts";

/**
 * 按行分割文本，去掉每行尾的 \r（CRLF 归一化，hash 基于干净行）。
 *
 * 约定：末尾换行视为最后一行的终止符，不产生多余空尾行。
 * - `"a\nb\n"` → `["a", "b"]`
 * - `"a\r\nb\r\n"` → `["a", "b"]`（\r 去掉）
 * - `"a\n\n"` → `["a", ""]`
 * - `""` → `[]`
 */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	return normalized.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** 检测文本的主导行尾（含 \r\n 即视为 CRLF）。 */
export function detectLineEnding(text: string): LineEnding {
	return text.includes("\r\n") ? "crlf" : "lf";
}

/** 把行数组 join 成文本，按指定行尾恢复（默认 LF）。非空文件末尾带换行。 */
export function joinLines(lines: readonly string[], ending: LineEnding = "lf"): string {
	if (lines.length === 0) return "";
	const sep = ending === "crlf" ? "\r\n" : "\n";
	return lines.join(sep) + sep;
}

/** 为文件创建快照：记录原文 + 行尾 + 每行 context-aware hash。 */
export function createSnapshot(path: string, text: string, len = 4): FileSnapshot {
	const lines = splitLines(text);
	const lineHashes = hashFileLines(lines, len);
	return { path, lineHashes, text, hashLen: len, lineEnding: detectLineEnding(text) };
}

/** 锚校验结果。 */
export type AnchorVerifyResult =
	| { readonly ok: true; readonly line: number }
	| {
			readonly ok: false;
			readonly error: "hash_not_found" | "line_mismatch" | "collision";
			/** hash 实际出现的行号（1-based）。 */
			readonly found?: readonly number[];
	  };

/**
 * 在快照中校验锚。
 *
 * - hash 唯一存在且行号匹配 → `ok`
 * - hash 唯一存在但行号不符 → `line_mismatch`（`found` 给真实行号；漂移，可由 relocate 中间件处理）
 * - hash 多处出现 → `collision`（`found` 给所有位置）
 * - hash 不存在 → `hash_not_found`（文件已变，需重读）
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

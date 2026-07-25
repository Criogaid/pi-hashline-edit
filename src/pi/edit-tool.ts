/**
 * Override edit：只接受 hashline patch（`input`）。
 *
 * 不兼容旧 oldText/newText——发现旧格式输入时明确报错，让开发者知道
 * 模型没用新方案，而非静默降级。容错仅限不影响结果的格式归一化
 * （parse 层的可选冒号、CRLF 等）；范式级兼容一概拒绝。
 *
 * 并发安全：read-modify-write 包在 withFileMutationQueue 里，串行化同文件
 * 的多次 edit，防止 pi 默认并行执行下丢数据。响应 AbortSignal——读后/写前
 * 检查，用户取消时不落盘。
 *
 * @module pi-hashline-edit/pi
 */

import { createEditTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, parsePatch } from "../core/index.ts";
import type { Edit, FileSnapshot, PatchError } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState, getSnapshot, putSnapshot, recordSnapshot } from "./state.ts";

// schema 不声明 additionalProperties:false：模型误发旧 edits/oldText/newText
// 时，这些额外字段原样到达 execute，由 missingInputError 检测并明确拒绝。
// 依赖 typebox 默认允许额外属性 + pi validation 不 strip —— 勿改这两点。

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	input: Type.Optional(
		Type.String({
			description:
				"Hashline patch referencing LINE#HASH anchors from your latest read. Ops: replace / delete / insert_after / insert_before / append / prepend. Body rows start with `+`. This tool does NOT accept legacy oldText/newText.",
		}),
	),
});

/** 把 PatchError 转成对模型有用的提示文本。 */
function errorText(e: PatchError, path: string): string {
	switch (e.kind) {
		case "stale":
			return `File ${path} changed since your last read. Re-read it before editing.`;
		case "anchor":
			return `Anchor mismatch: ${e.message}. Re-read ${path} to get current line hashes (LINE#HASH).`;
		case "collision":
			return `Hash collision: ${e.message}. Re-read ${path}.`;
		case "range":
			return `Bad range: ${e.message}`;
		case "noop":
			return `Edit produced no change: ${e.message}`;
		case "parse":
			return `Parse error${e.line ? ` at line ${e.line}` : ""}: ${e.message}`;
	}
}

/** 取应用后首个变更行（用于 firstChangedLine / TUI 跳转）。insert_after 取锚 +1。 */
function minAnchorLine(edits: readonly Edit[]): number | undefined {
	let min: number | undefined;
	for (const e of edits) {
		let line: number | undefined;
		if (e.op === "replace" || e.op === "delete") line = e.start.line;
		else if (e.op === "insert_after") line = e.anchor.line + 1;
		else if (e.op === "insert_before") line = e.anchor.line;
		else if (e.op === "prepend") line = 1;
		// append 无锚，跳过（末尾追加）
		if (line !== undefined && (min === undefined || line < min)) min = line;
	}
	return min;
}

/**
 * 模型未用 hashline（发了旧 oldText/newText 或缺 input）→ 明确告知，不静默降级。
 * 导出以便测试。params 用 any 以便检测 schema 外的旧格式字段。
 */
export function missingInputError(path: string, params: any): string {
	const legacy =
		Array.isArray(params?.edits) ||
		typeof params?.oldText === "string" ||
		typeof params?.newText === "string";
	if (legacy) {
		return `⚠ ${path}: you sent the legacy oldText/newText format, but this edit tool ONLY accepts hashline \`input\`. The legacy path was intentionally removed so this is surfaced, not silently degraded. Re-read ${path} to get LINE#HASH anchors, then send \`input\` (e.g. \`replace 4#aF3:\` followed by \`+\` body rows).`;
	}
	return `Edit ${path}: missing \`input\` (hashline patch). Read ${path} first, then send \`input\` referencing LINE#HASH anchors.`;
}

/** 构造错误 result（带 isError: true，让 TUI/agent loop 识别失败而非当成功）。 */
function errResult(text: string) {
	return {
		isError: true as const,
		content: [{ type: "text" as const, text }],
		details: undefined,
	};
}

export function makeEditOverride(cwd: string) {
	const builtin = createEditTool(cwd);

	return {
		name: "edit" as const,
		label: "edit",
		description:
			"Edit a file via hashline patch (LINE#HASH anchors, content-verified). Does NOT accept legacy oldText/newText.",
		promptSnippet: "Edit files via hashline LINE#HASH anchors (input patch); legacy oldText/newText not accepted",
		promptGuidelines: [
			"Pass `input`: a hashline patch referencing `LINE#HASH` anchors copied from your latest read output (e.g. `replace 12#aF3:`).",
			"Ops: `replace LINE#HASH[..LINE#HASH]:` · `delete LINE#HASH` · `insert_after LINE#HASH:` · `insert_before LINE#HASH:` · `append:` · `prepend:`.",
			"Body rows start with `+` followed by the literal line. `+` alone = blank line. Literal `+`/`-` lines become `++`/`+-`.",
			"After each successful edit, re-ground: line numbers shift, so take the next edit's anchors from a fresh read.",
			"This tool does NOT accept legacy oldText/newText — sending those returns an error (intentional, so it's visible).",
		],
		parameters: editSchema,
		renderShell: "self" as const,

		async execute(toolCallId: string, params: Static<typeof editSchema>, signal: AbortSignal | undefined, onUpdate: any) {
			const state = getState();
			// 用户主动关闭 hashline（config.enabled=false）→ 透传内置
			if (!state.config.enabled) return builtin.execute(toolCallId, params as any, signal, onUpdate);

			const path = params.path;
			const absPath = canonicalPath(cwd, path);
			const input = params.input;

			// 无 input → 明确告知（区分旧格式 vs 缺失），不静默降级
			if (typeof input !== "string" || input.trim() === "") {
				return errResult(missingInputError(path, params as any));
			}
			// withFileMutationQueue 串行化同文件的 read-modify-write，防并行 edit 丢数据
			return await withFileMutationQueue(absPath, () => runHashline(absPath, path, input, signal));
		},
	};
}

async function runHashline(absPath: string, displayPath: string, input: string, signal: AbortSignal | undefined) {
	let currentText: string;
	try {
		currentText = (await readFile(absPath)).toString("utf-8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error reading ${displayPath}: ${msg}`);
	}
	// 读后检查取消：用户 abort 则不继续 parse/apply，文件不变
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before apply.`);

	// 取已记录快照；若无（模型未 read）则用当前文件建立——anchor 校验仍会强制
	// 模型用真实 hash（没读过就猜不对），自然引导它先 read。
	const snap: FileSnapshot = getSnapshot(absPath) ?? recordSnapshot(absPath, currentText);

	// input 不含 file 头，prepend 一个让 parsePatch 通过（path 仅作标签）
	const parsed = parsePatch(`file: ${absPath}\n\n${input}`);
	if (!parsed.ok) {
		return errResult(errorText(parsed.error, displayPath));
	}

	const result = applyEdits(currentText, parsed.patch.edits, snap);
	if (!result.ok) {
		return errResult(errorText(result.error, displayPath));
	}

	// 写前检查取消：abort 则不落盘，文件不变
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before write.`);

	try {
		await writeFile(absPath, result.text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error writing ${displayPath}: ${msg}`);
	}

	// 更新快照：连续 edit 无需重读（result.newSnapshot 基于新文本），走 LRU
	putSnapshot(absPath, result.newSnapshot);

	return {
		content: [
			{ type: "text" as const, text: `Edited ${displayPath} (${parsed.patch.edits.length} op(s)).` },
		],
		details: {
			// details.diff 必须用 pi 的 generateDiffString（+N content 格式），
			// 内置 renderer 的 parseDiffLine 只认这个格式；core 的标准 unified diff 会被当纯文本灰显
			diff: generateDiffString(currentText, result.text),
			patch: generateUnifiedPatch(displayPath, currentText, result.text),
			firstChangedLine: minAnchorLine(parsed.patch.edits),
		},
	};
}

/**
 * 纯函数应用器：在快照对应的文件上应用编辑。
 *
 * 严格语义：
 * - 要求当前 `text === snapshot.text`（stale 检查）；漂移由 `transforms/relocate`
 *   中间件在调用 apply 前处理，纯 apply 不猜。
 * - 每个锚的 hash 必须匹配快照中对应行（防模型记错行号/hash）。
 * - 操作范围不得重叠（含同插入点）。
 * - body 与目标字节相同 → `noop` 错误（引导模型查 bug 而非盲目重试）。
 *
 * @module pi-hashline-edit/core
 */

import { buildDiff } from "./diff.ts";
import { createSnapshot, joinLines, splitLines } from "./snapshot.ts";
import type { ApplyResult, Edit, FileSnapshot, PatchError } from "./types.ts";

/** 行级操作：把 `[lo, hi)`（0-based，hi exclusive）区间的原始行替换为 newLines。 */
interface SpanOp {
	lo: number;
	hi: number;
	newLines: string[];
}

/** 校验锚匹配快照（纯 apply：text 已等于 snapshot.text，故只防记错）。 */
function checkAnchor(snapshot: FileSnapshot, line: number, hash: string): PatchError | null {
	if (line < 1 || line > snapshot.lineHashes.length) {
		return {
			kind: "anchor",
			message: `line ${line} does not exist (file has ${snapshot.lineHashes.length} lines)`,
		};
	}
	if (snapshot.lineHashes[line - 1] !== hash) {
		return {
			kind: "anchor",
			message: `hash mismatch at line ${line}: file has #${snapshot.lineHashes[line - 1]}, edit says #${hash}`,
		};
	}
	return null;
}

/** 把 Edit 翻译成 SpanOp，同时校验锚与范围。 */
function translateEdit(edit: Edit, snapshot: FileSnapshot): { op: SpanOp } | { error: PatchError } {
	switch (edit.op) {
		case "replace":
		case "delete": {
			const startErr = checkAnchor(snapshot, edit.start.line, edit.start.hash);
			if (startErr) return { error: startErr };
			let endLine = edit.start.line;
			if (edit.end) {
				const endErr = checkAnchor(snapshot, edit.end.line, edit.end.hash);
				if (endErr) return { error: endErr };
				endLine = edit.end.line;
			}
			if (endLine < edit.start.line) {
				return { error: { kind: "range", message: `range ${edit.start.line}..${endLine} ends before it starts` } };
			}
			return {
				op: {
					lo: edit.start.line - 1,
					hi: endLine,
					newLines: edit.op === "delete" ? [] : edit.body,
				},
			};
		}
		case "insert_after": {
			const err = checkAnchor(snapshot, edit.anchor.line, edit.anchor.hash);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line, hi: edit.anchor.line, newLines: edit.body } };
		}
		case "insert_before": {
			const err = checkAnchor(snapshot, edit.anchor.line, edit.anchor.hash);
			if (err) return { error: err };
			return { op: { lo: edit.anchor.line - 1, hi: edit.anchor.line - 1, newLines: edit.body } };
		}
		case "append": {
			return { op: { lo: snapshot.lineHashes.length, hi: snapshot.lineHashes.length, newLines: edit.body } };
		}
		case "prepend": {
			return { op: { lo: 0, hi: 0, newLines: edit.body } };
		}
	}
}

/** 零宽区间（插入点）的"最后影响位"是 lo；非零宽是 hi-1。 */
function maxAffected(op: SpanOp): number {
	return op.lo === op.hi ? op.lo : op.hi - 1;
}

/**
 * 在快照对应的文件上应用编辑。
 *
 * @param text     当前文件全文
 * @param edits    解析出的编辑操作
 * @param snapshot read 时记录的快照（text 必须等于当前 text）
 * @returns 应用结果；失败返回结构化错误
 */
export function applyEdits(text: string, edits: Edit[], snapshot: FileSnapshot): ApplyResult {
	if (text !== snapshot.text) {
		return {
			ok: false,
			error: { kind: "stale", message: "file changed since last read; re-read before editing" },
		};
	}

	const lines = splitLines(text);

	const ops: SpanOp[] = [];
	for (const edit of edits) {
		const t = translateEdit(edit, snapshot);
		if ("error" in t) return { ok: false, error: t.error };
		ops.push(t.op);
	}

	// 重叠检查：按 lo 升序，相邻 op 的起点不得落在前一个的影响区内
	const sorted = [...ops].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
	for (let k = 1; k < sorted.length; k++) {
		if (sorted[k].lo <= maxAffected(sorted[k - 1])) {
			return {
				ok: false,
				error: {
					kind: "range",
					message: `overlapping edits near line ${sorted[k].lo + 1}; issue one edit per range`,
				},
			};
		}
	}

	// 从后往前应用（lo 降序），避免行号偏移
	let result = [...lines];
	for (const op of [...sorted].sort((a, b) => b.lo - a.lo)) {
		result = [...result.slice(0, op.lo), ...op.newLines, ...result.slice(op.hi)];
	}

	const newText = joinLines(result, snapshot.lineEnding);
	if (newText === text) {
		return {
			ok: false,
			error: {
				kind: "noop",
				message:
					"edit parsed and applied cleanly but produced no change; body is byte-identical to the target — the bug is elsewhere, re-read first",
			},
		};
	}

	const newSnapshot = createSnapshot(snapshot.path, newText, snapshot.hashLen);
	const diff = buildDiff(snapshot.path, lines, sorted);
	return { ok: true, text: newText, newSnapshot, changed: true, diff };
}

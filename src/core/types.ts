/**
 * Hashline 核心类型定义。
 *
 * @module pi-hashline-edit/core
 */

/** 行锚：行号（1-based）+ 内容 hash 双重引用。 */
export interface Anchor {
	readonly line: number;
	readonly hash: string;
}

/**
 * 编辑操作。所有带行号的操作都通过 {@link Anchor} 引用——
 * 行号给人读，hash 给机器校验，二者必须同时匹配快照。
 */
export type Edit =
	| { readonly op: "replace"; readonly start: Anchor; readonly end?: Anchor; readonly body: string[] }
	| { readonly op: "delete"; readonly start: Anchor; readonly end?: Anchor }
	| { readonly op: "insert_after"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "insert_before"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "append"; readonly body: string[] }
	| { readonly op: "prepend"; readonly body: string[] };

export type LineEnding = "lf" | "crlf";

/** 文件快照：read 时记录的原文 + 每行 context-aware hash。 */
export interface FileSnapshot {
	readonly path: string;
	/** `lineHashes[i]` = 第 (i+1) 行的 hash，长度恒等于文件行数。 */
	readonly lineHashes: readonly string[];
	readonly text: string;
	/** 生成 lineHashes 时用的 hash 长度；apply 生成新快照时须沿用，避免长度不一致导致下次校验失败。 */
	readonly hashLen: number;
	/** 原文件行尾（lf/crlf）；apply 据此恢复，保证 CRLF 文件 edit 后行尾不变。 */
	readonly lineEnding: LineEnding;
}

/** 解析出的单个文件 patch。 */
export interface ParsedPatch {
	readonly path: string;
	readonly edits: Edit[];
}

/** 错误种类。 */
export type PatchErrorKind =
	| "parse" // 输入格式错误
	| "stale" // 文件已变（当前 text !== snapshot.text）
	| "anchor" // 锚 hash 不匹配快照（模型记错）或行号越界
	| "collision" // hash 在文件中多处出现，无法唯一定位
	| "range" // 操作范围非法（重叠、逆序、跨空等）
	| "noop"; // 编辑未产生变化（body 与目标行字节相同）

export interface PatchError {
	readonly kind: PatchErrorKind;
	readonly message: string;
	/** 输入 patch 中的行号（1-based），用于错误定位。 */
	readonly line?: number;
}

/** 应用结果。 */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly newSnapshot: FileSnapshot;
			readonly changed: boolean;
			readonly diff: string;
	  }
	| { readonly ok: false; readonly error: PatchError };

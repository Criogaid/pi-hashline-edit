/**
 * pi-hashline-edit 核心库公共 API。
 *
 * 纯 hashline 引擎，零 pi 依赖，可独立 `node --test`。
 * pi 接入层在 `../pi/` 下。
 *
 * @module pi-hashline-edit/core
 */

export * from "./types.ts";
export { computeLineHash, hashFileLines } from "./hash.ts";
export { splitLines, joinLines, createSnapshot, verifyAnchor } from "./snapshot.ts";
export type { AnchorVerifyResult } from "./snapshot.ts";
export { parsePatch } from "./parse.ts";
export type { ParseResult } from "./parse.ts";
export { applyEdits } from "./apply.ts";
export { buildDiff } from "./diff.ts";

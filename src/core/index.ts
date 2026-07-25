/**
 * Public API of the pi-hashline-edit core library.
 *
 * The pure hashline engine, with zero pi dependencies, runnable standalone via
 * `node --test`. The pi integration layer lives under `../pi/`.
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

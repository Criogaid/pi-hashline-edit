/**
 * Hashline core type definitions.
 *
 * @module pi-hashline-edit/core
 */

/** Line anchor: dual reference of line number (1-based) + content hash. */
export interface Anchor {
	readonly line: number;
	readonly hash: string;
}

/**
 * Edit operation. Every line-numbered op references a line via {@link Anchor} —
 * the line number is the address, the hash a checksum that the line at that
 * address is still what was read; both must match at apply time.
 */
export type Edit =
	| { readonly op: "replace"; readonly start: Anchor; readonly end?: Anchor; readonly body: string[] }
	| { readonly op: "delete"; readonly start: Anchor; readonly end?: Anchor }
	| { readonly op: "insert_after"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "insert_before"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "append"; readonly body: string[] }
	| { readonly op: "prepend"; readonly body: string[] };

export type LineEnding = "lf" | "crlf";

/** Error kinds. */
export type PatchErrorKind =
	| "anchor" // anchor hash does not match the current line content (line changed, or model misremembered) or line out of range
	| "range" // illegal operation range (overlap, reverse order, etc.)
	| "noop"; // edit produced no change (body byte-identical to the target)

export interface PatchError {
	readonly kind: PatchErrorKind;
	readonly message: string;
}

/**
 * Apply result. On success, `touchedLines` lists the 0-based line indices in
 * the NEW file that this edit produced (inserted or replaced) — callers use it
 * to surface fresh `LINE#HASH` anchors so the model can chain edits without a
 * re-read.
 */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly changed: boolean;
			readonly touchedLines: readonly number[];
	  }
	| { readonly ok: false; readonly error: PatchError };

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
 * address is still what was read; both must match the snapshot at once.
 */
export type Edit =
	| { readonly op: "replace"; readonly start: Anchor; readonly end?: Anchor; readonly body: string[] }
	| { readonly op: "delete"; readonly start: Anchor; readonly end?: Anchor }
	| { readonly op: "insert_after"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "insert_before"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "append"; readonly body: string[] }
	| { readonly op: "prepend"; readonly body: string[] };

export type LineEnding = "lf" | "crlf";

/** File snapshot: original text recorded at read time + per-line hash. */
export interface FileSnapshot {
	readonly path: string;
	/** `lineHashes[i]` = hash of line (i+1); length always equals the file's line count. */
	readonly lineHashes: readonly string[];
	readonly text: string;
	/** Hash length used when generating lineHashes; apply reuses it for the new snapshot. */
	readonly hashLen: number;
	/** Original file line ending (lf/crlf); apply restores it so a CRLF file keeps its endings. */
	readonly lineEnding: LineEnding;
}

/** Error kinds. */
export type PatchErrorKind =
	| "stale" // file changed (current text !== snapshot.text)
	| "anchor" // anchor hash does not match the snapshot (model misremembered) or line out of range
	| "range" // illegal operation range (overlap, reverse order, etc.)
	| "noop"; // edit produced no change (body byte-identical to the target)

export interface PatchError {
	readonly kind: PatchErrorKind;
	readonly message: string;
}

/** Apply result. */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly newSnapshot: FileSnapshot;
			readonly changed: boolean;
	  }
	| { readonly ok: false; readonly error: PatchError };

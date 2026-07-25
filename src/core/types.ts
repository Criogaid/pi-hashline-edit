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
 * the line number is for humans, the hash for machine verification; both must
 * match the snapshot at once.
 */
export type Edit =
	| { readonly op: "replace"; readonly start: Anchor; readonly end?: Anchor; readonly body: string[] }
	| { readonly op: "delete"; readonly start: Anchor; readonly end?: Anchor }
	| { readonly op: "insert_after"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "insert_before"; readonly anchor: Anchor; readonly body: string[] }
	| { readonly op: "append"; readonly body: string[] }
	| { readonly op: "prepend"; readonly body: string[] };

export type LineEnding = "lf" | "crlf";

/** File snapshot: original text recorded at read time + per-line context-aware hash. */
export interface FileSnapshot {
	readonly path: string;
	/** `lineHashes[i]` = hash of line (i+1); length always equals the file's line count. */
	readonly lineHashes: readonly string[];
	readonly text: string;
	/** Hash length used when generating lineHashes; apply must reuse it for the new snapshot to avoid length drift on the next verification. */
	readonly hashLen: number;
	/** Original file line ending (lf/crlf); apply restores it so a CRLF file keeps its line endings after edit. */
	readonly lineEnding: LineEnding;
}

/** A single parsed file patch. */
export interface ParsedPatch {
	readonly path: string;
	readonly edits: Edit[];
}

/** Error kinds. */
export type PatchErrorKind =
	| "parse" // malformed input
	| "stale" // file changed (current text !== snapshot.text)
	| "anchor" // anchor hash does not match the snapshot (model misremembered) or line out of range
	| "collision" // hash appears at multiple lines, cannot locate uniquely
	| "range" // illegal operation range (overlap, reverse order, spanning a gap, etc.)
	| "noop"; // edit produced no change (body byte-identical to the target)

export interface PatchError {
	readonly kind: PatchErrorKind;
	readonly message: string;
	/** Line number (1-based) in the input patch, for error localization. */
	readonly line?: number;
}

/** Apply result. */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly newSnapshot: FileSnapshot;
			readonly changed: boolean;
			readonly diff: string;
	  }
	| { readonly ok: false; readonly error: PatchError };

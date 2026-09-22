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

/**
 * Outcome of shifted-anchor recovery. When a cited anchor's hash no longer
 * matches the live content, the applicator rescans ±radius lines for content
 * whose checksum matches the cited anchor while holding the ORIGINAL line
 * number fixed. Because checksums can collide, a match is a candidate rather
 * than proof of identity. A ready-to-resend anchor is returned with the
 * candidate's freshly computed hash.
 *
 * - `found` — exactly one nearby line has the cited checksum; the caller checks
 *   its content before resending with the provided anchor.
 * - `ambiguous` — several nearby lines match; the caller inspects the candidates
 *   and chooses the intended target.
 * - `none` — no nearby line matches; re-read.
 */
export type AnchorRecovery =
	| { readonly kind: "found"; readonly newLine: number; readonly newHash: string }
	| {
			readonly kind: "ambiguous";
			readonly candidates: ReadonlyArray<{ readonly line: number; readonly hash: string }>;
	  }
	| { readonly kind: "none" };

/**
 * A single anchor that failed verification, with its recovery attempt.
 *
 * `opIndex` is the 0-based position in the input `edits[]`; `which` names the
 * op's anchor (`"anchor"` = start, `"end"` = range end); `op` is the op kind.
 * `current` is the cited line's live content + hash (null if the line number is
 * out of range) — surfaced when recovery is `none` so the model can self-diagnose.
 */
export interface AnchorFailure {
	readonly opIndex: number;
	readonly which: "anchor" | "end";
	readonly op: Edit["op"];
	readonly cited: Anchor;
	readonly recovery: AnchorRecovery;
	readonly current: { readonly hash: string; readonly content: string } | null;
}

/**
 * Record for one supplied anchor in the immutable apply snapshot.
 * not_checked means input validation rejected the batch before hashing.
 */
export interface AnchorCheck {
	readonly opIndex: number;
	readonly which: "anchor" | "end";
	readonly op: Edit["op"];
	readonly cited: Anchor;
	readonly status: "matched" | "mismatched" | "not_checked";
}

/** Batch-level failure. Anchor checks describe only checksum validation in this snapshot. */
export type ApplyFailure =
	| { readonly kind: "anchor"; readonly failures: readonly AnchorFailure[]; readonly checks: readonly AnchorCheck[] }
	| { readonly kind: "input" | "range"; readonly message: string; readonly checks: readonly AnchorCheck[] };

/**
 * Apply result. On success, `touchedLines` lists 0-based NEW-file indices to
 * re-anchor. `contextLines` identifies deletion successors among those lines;
 * callers retain their content while compacting anchors for caller-supplied rows.
 * Byte-identical output succeeds with changed=false and empty anchor lists.
 * On failure, `failure` is either the collected set of anchor failures
 * (each with recovery) or an input/range error, plus per-input anchor checks.
 * Nothing is written on failure.
 */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly changed: boolean;
			readonly touchedLines: readonly number[];
			readonly contextLines: readonly number[];
	  }
	| { readonly ok: false; readonly failure: ApplyFailure };

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
 * matches the live content, the applicator rescans ±radius lines for the
 * original content — holding the ORIGINAL line number fixed and re-hashing each
 * candidate's content (`computeLineHash(citedLine, candidateContent) === citedHash`
 * iff the candidate is the original content). A ready-to-resend anchor (with the
 * freshly computed hash) is returned so the model can retry without a re-read.
 *
 * - `found` — exactly one nearby line holds the original content; resend the op
 *   with the provided anchor.
 * - `ambiguous` — several nearby lines match (e.g. duplicate content); the model
 *   picks the right one from the candidates (each carries its own new hash).
 * - `none` — the content genuinely changed; re-read.
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

/** Batch-level failure. `anchor` carries every per-anchor failure collected across the batch. */
export type ApplyFailure =
	| { readonly kind: "anchor"; readonly failures: readonly AnchorFailure[] }
	| { readonly kind: "range"; readonly message: string }
	| { readonly kind: "noop"; readonly message: string };

/**
 * Apply result. On success, `touchedLines` lists the 0-based line indices in
 * the NEW file that this edit produced (inserted or replaced) — callers use it
 * to surface fresh `LINE#HASH` anchors so the model can chain edits without a
 * re-read. On failure, `failure` is either the collected set of anchor failures
 * (each with recovery) or a single range/noop error; nothing is written.
 */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly changed: boolean;
			readonly touchedLines: readonly number[];
	  }
	| { readonly ok: false; readonly failure: ApplyFailure };

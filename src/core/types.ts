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

/** Public anchor field names shared by preparation, verification, and recovery. */
export const EDIT_ANCHOR_FIELDS = ["anchor", "end", "before", "after"] as const;
type AnchorField = (typeof EDIT_ANCHOR_FIELDS)[number];

/**
 * Edit operation. Every line-numbered op references a line via {@link Anchor} —
 * the line number is the address, the hash a checksum that the line at that
 * address is still what was read; both must match at apply time.
 */
export type Edit =
  | {
      readonly op: "replace";
      readonly anchor: Anchor;
      readonly end?: Anchor;
      readonly body: string[];
    }
  | { readonly op: "delete"; readonly anchor: Anchor; readonly end?: Anchor }
  | ({ readonly op: "copy" | "move"; readonly anchor: Anchor; readonly end?: Anchor } & (
      | { readonly before: Anchor; readonly after?: never }
      | { readonly after: Anchor; readonly before?: never }
    ))
  | { readonly op: "insert_after"; readonly anchor: Anchor; readonly body: string[] }
  | { readonly op: "insert_before"; readonly anchor: Anchor; readonly body: string[] }
  | { readonly op: "append"; readonly body: string[] }
  | { readonly op: "prepend"; readonly body: string[] };

/**
 * Outcome of shifted-anchor recovery. Search ±radius first; only if there are
 * no candidates, search the rest of the file. Radius 0 disables recovery.
 * Candidate checksums hold the ORIGINAL line number fixed. Because checksums
 * can collide, a match is a candidate rather than proof of identity. Returned
 * anchors use each candidate's actual line number and freshly computed hash.
 *
 * - `found` — exactly one line matches; the caller checks its content before
 *   resending with the provided anchor.
 * - `ambiguous` — several lines match; the caller inspects the candidates
 *   and chooses the intended target.
 * - `none` — no candidate found, or recovery disabled; the caller checks the
 *   current cited line, if any, or re-reads.
 */
export type AnchorRecovery =
  | {
      readonly kind: "found";
      readonly newLine: number;
      readonly newHash: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: ReadonlyArray<{ readonly line: number; readonly hash: string }>;
    }
  | { readonly kind: "none" };

/**
 * A single anchor that failed verification, with its recovery attempt.
 *
 * `opIndex` is the 0-based position in the input `edits[]`; `which` names the
 * op's source/insertion anchor, range end, or before/after destination; `op` is the op kind.
 */
export interface AnchorFailure {
  readonly opIndex: number;
  readonly which: AnchorField;
  readonly op: Edit["op"];
  readonly cited: Anchor;
  readonly recovery: AnchorRecovery;
}

/**
 * Apply result. Byte-identical output is a success; the commit layer detects the no-op.
 * On failure, `failures` is the collected set of anchor failures, each with recovery;
 * the tool layer bounds and formats them. Nothing is written on failure.
 */
export type ApplyResult =
  | {
      readonly ok: true;
      readonly text: string;
    }
  | { readonly ok: false; readonly failures: readonly AnchorFailure[] };

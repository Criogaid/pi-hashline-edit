/**
 * Fixed model-facing output budgets.
 *
 * README "Output budgets" documents each value; change both together. Result
 * and notice text derive their size wording from these constants. Budgets that
 * users can configure (read line and byte limits, grep line limit) live in the
 * settings schema in config.ts; Pi's own total-output limit stays with Pi.
 *
 * @module pi-hashline-edit/pi
 */

/** grep line preview, in UTF-16 units, excluding its partial-line label. */
export const GREP_MAX_LINE_LENGTH = 500;

/** Each diagnostic or anchor block: failure details, input-anchor checks, candidate neighborhoods, mutation anchors. */
export const MAX_BLOCK_BYTES = 16 * 1024;
/** One recovery-candidate or cited row inside a failure diagnostic. */
export const MAX_RECOVERY_CANDIDATE_BYTES = 4 * 1024;
/** grep search diagnostics appended to a result. */
export const MAX_SEARCH_DIAGNOSTIC_BYTES = 4 * 1024;

/** Size wording for notices, e.g. `16 KiB`. */
export function formatKiB(bytes: number): string {
  return `${bytes / 1024} KiB`;
}

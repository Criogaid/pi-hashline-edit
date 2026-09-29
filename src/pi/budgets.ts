/**
 * Model-facing output byte budgets.
 *
 * README "Output budgets" documents each value; change both together. Result
 * and notice text derive their size wording from these constants.
 *
 * @module pi-hashline-edit/pi
 */

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

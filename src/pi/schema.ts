/**
 * Shared input constraints for tool schemas and settings.
 *
 * Tool parameters and `hashlineEdit` settings use the same integer rules, so
 * both read them from here rather than restating bounds per call site.
 *
 * @module pi-hashline-edit/pi
 */

/** JSON Schema keywords for an integer in [minimum, maximum]; fractions are rejected, not rounded. */
export function integerRange(minimum: number, maximum: number) {
  return { minimum, multipleOf: 1, maximum };
}

/** Positive line numbers, line counts, and match limits. */
export const POSITIVE_SAFE_INTEGER = integerRange(1, Number.MAX_SAFE_INTEGER);

/** Runtime counterpart of {@link integerRange} for values not validated by a schema. */
export function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

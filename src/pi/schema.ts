/**
 * Shared input constraints for tool schemas and settings.
 *
 * Tool parameters and `hashlineEdit` settings use the same integer rules, so
 * both read them from here rather than restating bounds per call site.
 *
 * @module pi-hashline-edit/pi
 */

import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";

/**
 * Every tool's sampling request: providers that support it enforce the parameter schema while
 * sampling, and the rest sample as usual. Pi's strict converter rejects object and array
 * unions, so no tool schema uses them.
 */
export const STRICT_SAMPLING = {
  type: "json_schema",
  strict: "prefer",
} as const satisfies ConstrainedSamplingConfig;

/** JSON Schema keywords for an integer in [minimum, maximum]; fractions are rejected, not rounded. */
export function integerRange(minimum: number, maximum: number) {
  return { minimum, multipleOf: 1, maximum };
}

/** Positive line numbers, line counts, and match limits. */
export const POSITIVE_SAFE_INTEGER = integerRange(1, Number.MAX_SAFE_INTEGER);

/** grep `context` parameter and its configured default. */
export const GREP_CONTEXT_RANGE = integerRange(0, 20);

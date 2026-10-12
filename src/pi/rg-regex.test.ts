import assert from "node:assert/strict";
import { test } from "node:test";
import { lineCandidatePatterns } from "./rg-regex.ts";

// These expressions are the byte-level boundary contract, including deliberate widening.
for (const [pattern, flags, expected] of [
  ["a$", "", "a\\r?$"],
  ["[A-Z]{10,}", "m", "(?:[A-Z]){10,}"],
  ["(?m:^)b", "", "(?:^|[\\r\\x{2028}\\x{2029}])b"],
  ["(\\w)\\1{4}", "m", "[0-9A-Z_a-z](?:[0-9A-Z_a-z]){4,4}"],
] as const) {
  test(`line candidates ${pattern} /${flags} → preserve required byte positions`, () => {
    assert.deepEqual(
      lineCandidatePatterns({ patterns: [pattern], literal: false, flags, multiline: false }),
      [expected],
    );
  });
}

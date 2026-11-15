import assert from "node:assert/strict";
import { test } from "node:test";
import { lineCandidatePatterns } from "./rg-regex.ts";

// These expressions are the byte-level boundary contract, including deliberate widening.
for (const [pattern, expected] of [
  ["a$", "a(?:[\\r\\x{2028}\\x{2029}]|\\r?$)"],
  ["[A-Z]{10,}", "(?:[A-Z]){10,}"],
  ["(?m:^)b", "(?:^|[\\r\\x{2028}\\x{2029}])b"],
  ["(\\w)\\1{4}", "[0-9A-Z_a-z](?:[0-9A-Z_a-z]){4,4}"],
] as const) {
  test(`line candidates ${pattern} → preserve required byte positions`, () => {
    assert.deepEqual(
      lineCandidatePatterns({
        patterns: [pattern],
        literal: false,
        ignoreCase: false,
        multiline: false,
      }),
      [expected],
    );
  });
}

test("deeply nested pattern → line candidates retain the native match", () => {
  for (const depth of [50, 200, 500, 1_000, 2_000, 4_000]) {
    const pattern = `${"(?:".repeat(depth)}A${")".repeat(depth)}`;
    assert.equal(new RegExp(pattern).test("A"), true);
    const candidates = lineCandidatePatterns({
      patterns: [pattern],
      literal: false,
      ignoreCase: false,
      multiline: false,
    });
    // An unavailable line analysis delegates candidate discovery to the file prefilter.
    assert.ok(
      candidates === undefined || candidates.some((candidate) => new RegExp(candidate).test("A")),
    );
  }
});

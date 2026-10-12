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

for (const [pattern, expected] of [
  ["[[a-c]&&[b-d]]", "[b-c]"],
  ["[[a-c]--[b]]", "[ac]"],
  ["[\\p{ASCII}&&\\p{Letter}]", "[A-Za-z]"],
  ["[\\p{Letter}&&[a-c]]", "[a-c]"],
  ["[[a-c]--\\p{Uppercase_Letter}]", "[a-c]"],
  ["[a[bc]\\q{de|fg}]", "(?:[a-c]|de|fg)"],
  ["[\\q{ab|cd}&&\\q{cd|ef}]", "cd"],
  ["[\\q{ab|cd}--\\q{cd}]", "ab"],
  ["[\\q{ab|}]", "(?:ab|)"],
  ["[[a]--[a]]", "[^\\x{0}-\\x{10ffff}]"],
] as const) {
  test(`finite v class ${pattern} → narrow candidates without discarding strings`, () => {
    assert.deepEqual(
      lineCandidatePatterns({ patterns: [pattern], literal: false, flags: "v", multiline: false }),
      [expected],
    );
  });
}

test("capture disables i inside a caseless reference → retain the reference's case variants", () => {
  assert.deepEqual(
    lineCandidatePatterns({
      patterns: ["((?-i:[[a]--[A]]))(?i:\\1)"],
      literal: false,
      flags: "v",
      multiline: false,
    }),
    ["a[Aa]"],
  );
});

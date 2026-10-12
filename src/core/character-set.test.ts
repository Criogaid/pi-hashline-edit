import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contains,
  intersect,
  subtract,
  membership,
  nativeCharacterRanges,
} from "./character-set.ts";

for (const [source, flags] of [
  ["\\p{Letter}", "u"],
  ["[^\\p{Letter}]", "v"],
  ["[\\p{Letter}--[a-z]]", "iv"],
  ["(?i:[kſΣ])", "u"],
  ["[\\q{ab|😀|}]", "v"],
  ["\\uD83D", ""],
  [".", ""],
  [".", "s"],
] as const) {
  test(`native character intervals ${source} /${flags} → agree with the host engine`, () => {
    const ranges = nativeCharacterRanges(source, flags);
    const native = membership(source, flags);
    for (const char of [
      "a",
      "A",
      "1",
      "\n",
      "\r",
      "\u2028",
      "\u0558",
      "ſ",
      "K",
      "Σ",
      "ς",
      "é",
      "𐐀",
      "😀",
      "\ud83d",
      "�",
    ]) {
      const isUnit = flags.includes("u") || flags.includes("v") || char.length === 1;
      assert.equal(
        contains(ranges, char.codePointAt(0)!),
        isUnit && native.test(char),
        `${source}: ${JSON.stringify(char)}`,
      );
    }
  });
}

test("interval intersection and difference → preserve included and excluded endpoints", () => {
  assert.deepEqual(
    intersect(
      [
        [1, 4],
        [8, 10],
      ],
      [[3, 8]],
    ),
    [
      [3, 4],
      [8, 8],
    ],
  );
  assert.deepEqual(
    subtract(
      [[1, 10]],
      [
        [0, 1],
        [4, 7],
        [10, 12],
      ],
    ),
    [
      [2, 3],
      [8, 9],
    ],
  );
});

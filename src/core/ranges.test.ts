import assert from "node:assert/strict";
import { test } from "node:test";
import { findSortedRangeConflict, mergeRanges, type HalfOpenRange } from "./ranges.ts";

test("sorted ranges sharing or crossing boundaries → report conflicts according to insertion policy", () => {
  const cases: [HalfOpenRange[], number | undefined, number | undefined][] = [
    [[], undefined, undefined],
    [
      [
        [0, 2],
        [2, 4],
      ],
      undefined,
      undefined,
    ],
    [
      [
        [0, 2],
        [2, 2],
      ],
      undefined,
      undefined,
    ],
    [
      [
        [0, 0],
        [0, 0],
      ],
      1,
      1,
    ],
    [
      [
        [0, 0],
        [0, 2],
      ],
      1,
      undefined,
    ],
    [
      [
        [0, 0],
        [0, 0],
        [0, 2],
      ],
      1,
      1,
    ],
    [
      [
        [0, 3],
        [1, 1],
      ],
      1,
      1,
    ],
    [
      [
        [0, 3],
        [1, 2],
      ],
      1,
      1,
    ],
    [
      [
        [0, 2],
        [0, 3],
      ],
      1,
      1,
    ],
    [
      [
        [0, 2],
        [0, 2],
      ],
      1,
      1,
    ],
    [
      [
        [0, 1],
        [1, 2],
        [1, 3],
      ],
      2,
      2,
    ],
  ];
  for (const [ranges, strictConflict, insertionBeforeRangeConflict] of cases) {
    for (const insertBeforeRange of [false, true]) {
      const expected = insertBeforeRange ? insertionBeforeRangeConflict : strictConflict;
      for (const shift of [0, 10]) {
        assert.equal(
          findSortedRangeConflict(
            ranges.map(([start, end]) => [start + shift, end + shift]),
            insertBeforeRange,
          ),
          expected,
          JSON.stringify({ ranges, insertBeforeRange, shift }),
        );
      }
    }
  }
});

test("range merging preserves input and coalesces overlap, containment, and adjacency", () => {
  const ranges: HalfOpenRange[] = [
    [7, 9],
    [1, 3],
    [2, 3],
    [3, 5],
  ];
  const before = structuredClone(ranges);
  assert.deepEqual(mergeRanges(ranges), [
    [1, 5],
    [7, 9],
  ]);
  assert.deepEqual(ranges, before);
  assert.deepEqual(mergeRanges([]), []);
});

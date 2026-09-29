import { test } from "node:test";
import assert from "node:assert/strict";
import { submatchesToLineRanges } from "./rg-line-ranges.ts";

test("multiline submatches map to distinct physical lines without inventing boundary lines", () => {
  assert.deepEqual(
    submatchesToLineRanges(
      Buffer.from("alpha\nbeta\ngamma\n"),
      1,
      [
        { start: 0, end: 10 },
        { start: 6, end: 16 },
      ],
      3,
    ),
    [[1, 4]],
  );
  assert.deepEqual(
    submatchesToLineRanges(Buffer.from("alpha\nbeta\n"), 1, [{ start: 0, end: 6 }], 2),
    [[1, 2]],
  );
  assert.deepEqual(submatchesToLineRanges(Buffer.alloc(0), 1, [{ start: 0, end: 0 }], 0), []);
});

test("zero-width EOF and UTF-8 offsets retain real lines and UTF-16 columns", () => {
  const bytes = Buffer.from("\u{1F600}\u754Cneedle\ntail");
  const columns = new Map<number, number>();
  assert.deepEqual(
    submatchesToLineRanges(
      bytes,
      1,
      [
        { start: 7, end: 13 },
        { start: bytes.length, end: bytes.length },
      ],
      2,
      columns,
    ),
    [[1, 3]],
  );
  assert.deepEqual(
    [...columns],
    [
      [1, 3],
      [2, 4],
    ],
  );
  assert.deepEqual(submatchesToLineRanges(Buffer.from("last"), 1, [{ start: 4, end: 4 }], 1), [
    [1, 2],
  ]);
});

test("invalid multiline match offsets fail before anchoring", () => {
  assert.throws(
    () => submatchesToLineRanges(Buffer.from("a"), 1, [{ start: 0, end: 2 }], 1),
    /Invalid rg submatch byte offsets/,
  );
  assert.throws(
    () => submatchesToLineRanges(Buffer.from("alpha\nbeta\n"), 1, [{ start: 0, end: 10 }], 1),
    /File changed during search/,
  );
  assert.throws(
    () => submatchesToLineRanges(Buffer.from("last\n"), 1, [{ start: 5, end: 5 }], 1),
    /File changed during search/,
  );
});

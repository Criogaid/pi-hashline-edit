import { test } from "node:test";
import assert from "node:assert/strict";
import { intersectRanges, normalizeRanges, submatchesToLineRanges, subtractRanges, unionRanges } from "./rg-line-ranges.ts";

test("normalizes and combines half-open physical line ranges", () => {
  assert.deepEqual(normalizeRanges([[5, 7], [1, 3], [3, 5], [9, 10]]), [[1, 7], [9, 10]]);
  assert.deepEqual(unionRanges([[1, 2], [5, 7]], [[2, 4], [8, 9]]), [[1, 4], [5, 7], [8, 9]]);
  assert.deepEqual(intersectRanges([[1, 5], [8, 10]], [[3, 9]]), [[3, 5], [8, 9]]);
  assert.deepEqual(subtractRanges([[1, 8]], [[2, 4], [6, 9]]), [[1, 2], [4, 6]]);
});

test("maps UTF-8 byte offsets and exact newline boundaries to physical lines", () => {
  const bytes = Buffer.from("前alpha\nbeta\n", "utf8");
  assert.deepEqual(submatchesToLineRanges(bytes, 4, [{ start: 3, end: 13 }], 10), [[4, 6]]);
  assert.deepEqual(submatchesToLineRanges(Buffer.from("alpha\nbeta\n"), 2, [{ start: 0, end: 6 }], 5), [[2, 3]]);
  assert.deepEqual(submatchesToLineRanges(Buffer.from("alpha\r\nbeta\r\n"), 2, [{ start: 0, end: 11 }], 5), [[2, 4]]);
});

test("resolves zero-width boundaries without inventing physical lines", () => {
  const bytes = Buffer.from("a\nb\n");
  assert.deepEqual(submatchesToLineRanges(bytes, 1, [{ start: 0, end: 0 }, { start: 2, end: 2 }], 2), [[1, 3]]);
  assert.deepEqual(submatchesToLineRanges(bytes, 1, [{ start: 1, end: 1 }, { start: 3, end: 3 }], 2), [[1, 3]]);
  assert.deepEqual(submatchesToLineRanges(Buffer.from("b"), 2, [{ start: 1, end: 1 }], 2), [[2, 3]]);
  assert.deepEqual(submatchesToLineRanges(Buffer.alloc(0), 1, [{ start: 0, end: 0 }], 0), []);
});

test("rejects malformed ranges and rg byte offsets", () => {
  assert.throws(() => normalizeRanges([[0, 1]]), /Invalid physical line range/);
  assert.throws(() => submatchesToLineRanges(Buffer.from("a"), 1, [{ start: 0, end: 2 }], 1), /Invalid rg submatch/);
});

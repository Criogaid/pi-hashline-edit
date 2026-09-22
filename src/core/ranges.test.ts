import assert from "node:assert/strict";
import { test } from "node:test";
import { findSortedRangeConflict, mergeRanges, type HalfOpenRange } from "./ranges.ts";

test("conflicts distinguish adjacent ranges from insertions at starts and interiors", () => {
	const cases: [HalfOpenRange[], number | undefined][] = [
		[[], undefined],
		[[[0, 2], [2, 4]], undefined],
		[[[0, 2], [2, 2]], undefined],
		[[[0, 0], [0, 0]], 1],
		[[[0, 0], [0, 2]], 1],
		[[[0, 3], [1, 1]], 1],
		[[[0, 3], [1, 2]], 1],
		[[[0, 1], [1, 2], [1, 3]], 2],
	];
	for (const [ranges, expected] of cases) {
		assert.equal(findSortedRangeConflict(ranges), expected);
		assert.equal(findSortedRangeConflict(ranges.map(([start, end]) => [start + 10, end + 10])), expected);
	}
});

test("range merging preserves input and coalesces overlap, containment, and adjacency", () => {
	const ranges: HalfOpenRange[] = [[7, 9], [1, 3], [2, 3], [3, 5]];
	const before = structuredClone(ranges);
	assert.deepEqual(mergeRanges(ranges), [[1, 5], [7, 9]]);
	assert.deepEqual(ranges, before);
	assert.deepEqual(mergeRanges([]), []);
});

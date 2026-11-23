/**
 * Deterministic 2-way (pairwise) covering-array generator for three orthogonal test axes.
 * Sorting axes by non-increasing length and setting the third coordinate to `(i + j) % |A_2|`
 * covers every pair across all three axis pairs in the minimum `|A_0| * |A_1|` rows.
 */
import assert from "node:assert/strict";

export function pairwise<A, B, C>(
  first: readonly A[],
  second: readonly B[],
  third: readonly C[],
): readonly (readonly [A, B, C])[] {
  const lengths: readonly [number, number, number] = [first.length, second.length, third.length];
  for (const [axis, length] of lengths.entries()) {
    assert(length > 0, `Axis ${axis} must not be empty`);
  }
  const order = [0, 1, 2].sort((a, b) => lengths[b] - lengths[a]);
  const indices: [number, number, number][] = [];
  for (let i = 0; i < lengths[order[0]]; i++) {
    for (let j = 0; j < lengths[order[1]]; j++) {
      const coords: [number, number, number] = [0, 0, 0];
      coords[order[0]] = i;
      coords[order[1]] = j;
      coords[order[2]] = (i + j) % lengths[order[2]];
      indices.push(coords);
    }
  }
  for (let left = 0; left < lengths.length; left++) {
    for (let right = left + 1; right < lengths.length; right++) {
      const expected = lengths[left] * lengths[right];
      const actual = new Set(indices.map((row) => `${row[left]}:${row[right]}`)).size;
      assert.equal(actual, expected, `Incomplete pairwise coverage for axes ${left} × ${right}`);
    }
  }
  return indices.map(([i, j, k]) => [first[i], second[j], third[k]]);
}

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
  const axes: readonly [readonly unknown[], readonly unknown[], readonly unknown[]] = [
    first,
    second,
    third,
  ];
  for (const [axis, values] of axes.entries()) {
    assert(values.length > 0, `Axis ${axis} must not be empty`);
  }
  const order = [0, 1, 2].sort((a, b) => axes[b].length - axes[a].length);
  const [a0, a1, a2] = order.map((index) => axes[index]);
  const rows: [A, B, C][] = [];
  for (let i = 0; i < a0.length; i++) {
    for (let j = 0; j < a1.length; j++) {
      const tuple = Array.from({ length: 3 });
      tuple[order[0]] = a0[i];
      tuple[order[1]] = a1[j];
      tuple[order[2]] = a2[(i + j) % a2.length];
      rows.push(tuple as [A, B, C]);
    }
  }
  for (let left = 0; left < axes.length; left++) {
    for (let right = left + 1; right < axes.length; right++) {
      const expected = axes[left].length * axes[right].length;
      const actual = new Set(
        rows.map((row) => `${axes[left].indexOf(row[left])}:${axes[right].indexOf(row[right])}`),
      ).size;
      assert.equal(actual, expected, `Incomplete pairwise coverage for axes ${left} × ${right}`);
    }
  }
  return rows;
}

/** Half-open bounds in a caller-selected unit (line indices or string offsets). */
export type HalfOpenRange = readonly [start: number, end: number];

/**
 * Find the first conflicting pair's second index. Input must be sorted by start, then end.
 * A range starting inside an earlier non-empty range conflicts, and so do two insertions
 * (empty ranges) at one position. An insertion at the start of a non-empty range also
 * conflicts unless `insertBeforeRange` is set; then it applies before that range.
 */
export function findSortedRangeConflict(
  ranges: readonly HalfOpenRange[],
  insertBeforeRange = false,
): number | undefined {
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (
      current[0] < previous[1] ||
      (current[0] === previous[0] && (!insertBeforeRange || current[1] === previous[1]))
    )
      return i;
  }
  return undefined;
}

/** Merge overlapping or adjacent ranges; callers validate their own units and bounds. */
export function mergeRanges(ranges: readonly HalfOpenRange[]): HalfOpenRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: HalfOpenRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (!previous || range[0] > previous[1]) result.push(range);
    else if (range[1] > previous[1]) result[result.length - 1] = [previous[0], range[1]];
  }
  return result;
}

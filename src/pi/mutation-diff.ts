import { diffLines } from "diff";
import type { CopiedSpan } from "../core/copy-span.ts";
import { indexSourceLines, normalizeLineEndings } from "../core/lines.ts";

const CONTEXT_LINES = 4;
// Bound the search by changed lines so large ranges with a few edits can still align.
const MAX_ALIGNMENT_EDITS = 128;

type LineIndex = ReturnType<typeof indexSourceLines>;

function boundaryAtOrAfter(lines: LineIndex, offset: number): number {
  let low = 0;
  let high = lines.length + 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (lines.start(middle) < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Render copied full rows at their proven positions and diff the gaps in the logical LF view. */
export function generateRangeDiff(
  before: string,
  after: string,
  copied: readonly CopiedSpan[],
): string {
  const source = indexSourceLines(before);
  const target = indexSourceLines(after);
  // The card shows net logical changes even when edit operations rearrange identical rows.
  if (
    source.length === target.length &&
    normalizeLineEndings(before) === normalizeLineEndings(after)
  )
    return "";
  // Pi's number column includes the empty slot after a final LF (or in an empty file).
  const width = String(
    Math.max(
      source.length + Number(!before || before.endsWith("\n")),
      target.length + Number(!after || after.endsWith("\n")),
    ),
  ).length;
  const output: string[] = [];
  let oldRow = 0;
  let newRow = 0;
  let equalRows = 0;
  let changed = false;

  function row(kind: " " | "-" | "+", index: LineIndex, line: number): void {
    output.push(`${kind}${String(line + 1).padStart(width)} ${index.content(line)}`);
  }

  function flushEqual(followedByChange: boolean): void {
    if (changed || followedByChange) {
      const head = changed ? Math.min(equalRows, CONTEXT_LINES) : 0;
      const tail = followedByChange ? Math.max(head, equalRows - CONTEXT_LINES) : equalRows;
      for (let i = 0; i < head; i++) row(" ", source, oldRow + i);
      if (tail > head) output.push(`${" ".repeat(width + 2)}...`);
      for (let i = tail; i < equalRows; i++) row(" ", source, oldRow + i);
    }
    oldRow += equalRows;
    newRow += equalRows;
    equalRows = 0;
  }

  function emitChange(kind: "-" | "+", count: number): void {
    if (!count) return;
    flushEqual(true);
    changed = true;
    if (kind === "-") {
      for (let i = 0; i < count; i++) row("-", source, oldRow++);
    } else {
      for (let i = 0; i < count; i++) row("+", target, newRow++);
    }
  }

  function rowsEqual(sourceRow: number, targetRow: number): boolean {
    const sourceTerminated = source.end(sourceRow) < source.start(sourceRow + 1);
    const targetTerminated = target.end(targetRow) < target.start(targetRow + 1);
    return (
      sourceTerminated === targetTerminated &&
      source.content(sourceRow) === target.content(targetRow)
    );
  }

  function diffGap(oldEnd: number, newEnd: number): void {
    const oldStart = oldRow + equalRows;
    const newStart = newRow + equalRows;
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    if (!oldCount || !newCount) {
      emitChange("-", oldCount);
      emitChange("+", newCount);
      return;
    }

    const oldOffset = source.start(oldStart);
    const newOffset = target.start(newStart);
    const oldLimit = source.start(oldEnd);
    const newLimit = target.start(newEnd);
    const parts = diffLines(
      normalizeLineEndings(before.slice(oldOffset, oldLimit)),
      normalizeLineEndings(after.slice(newOffset, newLimit)),
      { maxEditLength: MAX_ALIGNMENT_EDITS },
    );
    if (parts) {
      for (const part of parts) {
        if (part.removed) emitChange("-", part.count);
        else if (part.added) emitChange("+", part.count);
        else equalRows += part.count;
      }
      return;
    }

    // A dense gap still shows both real ranges, with any equal edges kept as context.
    let prefix = 0;
    while (prefix < Math.min(oldCount, newCount) && rowsEqual(oldStart + prefix, newStart + prefix))
      prefix++;
    let suffix = 0;
    while (
      suffix < Math.min(oldCount, newCount) - prefix &&
      rowsEqual(oldEnd - suffix - 1, newEnd - suffix - 1)
    )
      suffix++;
    equalRows += prefix;
    emitChange("-", oldCount - prefix - suffix);
    emitChange("+", newCount - prefix - suffix);
    equalRows += suffix;
  }

  for (const { sourceStart, targetStart, length } of copied) {
    // If either start is partial, the first copied LF is the first possible joint boundary.
    const firstSource = boundaryAtOrAfter(source, sourceStart);
    const firstTarget = boundaryAtOrAfter(target, targetStart);
    const skip = Math.max(
      source.start(firstSource) - sourceStart,
      target.start(firstTarget) - targetStart,
    );
    if (skip >= length) continue;
    const oldAnchor = boundaryAtOrAfter(source, sourceStart + skip);
    const newAnchor = boundaryAtOrAfter(target, targetStart + skip);
    const oldEnd = boundaryAtOrAfter(source, sourceStart + length + 1) - 1;
    const newEnd = boundaryAtOrAfter(target, targetStart + length + 1) - 1;
    // An unterminated last row is complete only at EOF on both sides.
    const count = Math.min(oldEnd - oldAnchor, newEnd - newAnchor);
    if (count <= 0) continue;
    diffGap(oldAnchor, newAnchor);
    equalRows += count;
  }
  diffGap(source.length, target.length);
  flushEqual(false);
  return output.join("\n");
}

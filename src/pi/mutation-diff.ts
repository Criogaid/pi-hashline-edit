import { diffArrays } from "diff";
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

// Match a copied EOF body to its original row when adding or removing its neighbor
// also adds or removes the separator. A terminator-only change still shows as an edit.
function copiedEofBody(
  shorter: LineIndex,
  longer: LineIndex,
  shorterStart: number,
  longerStart: number,
  length: number,
): number | undefined {
  const eofRow = shorter.length - 1;
  const bodyEnd = shorter.start(shorter.length);
  if (shorterStart + length !== bodyEnd || shorter.end(eofRow) !== bodyEnd) return;
  const skip = shorter.start(eofRow) - shorterStart;
  if (skip < 0) return;
  const start = longerStart + skip;
  const row = boundaryAtOrAfter(longer, start);
  if (
    row < longer.length - 1 &&
    longer.start(row) === start &&
    longer.end(row) === longerStart + length
  )
    return row;
}

type RowToken = string | symbol;

function rowTokens(index: LineIndex, start: number, end: number): RowToken[] {
  const tokens: RowToken[] = [];
  for (let row = start; row < end; row++) {
    const content = index.content(row);
    tokens.push(index.end(row) < index.start(row + 1) ? `${content}\n` : content);
  }
  return tokens;
}

function sameRow(before: RowToken, after: RowToken): boolean {
  return before === after;
}

/** Render copied full rows at their proven positions and diff the gaps in the logical LF view. */
export function generateRangeDiff(
  before: string,
  after: string,
  copied: readonly CopiedSpan[],
): string {
  // A header BOM stays at byte zero even when the body of the first row moves.
  const sharedBom = before.startsWith("\uFEFF") && after.startsWith("\uFEFF");
  const source = lineIndex(before);
  const target = lineIndex(after);

  function lineIndex(text: string): LineIndex {
    const lines = indexSourceLines(text);
    return sharedBom ? { ...lines, start: (row) => (row === 0 ? 1 : lines.start(row)) } : lines;
  }
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

  function diffGap(oldEnd: number, newEnd: number, eofSpan?: CopiedSpan): void {
    const oldStart = oldRow + equalRows;
    const newStart = newRow + equalRows;
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    if (!oldCount || !newCount) {
      emitChange("-", oldCount);
      emitChange("+", newCount);
      return;
    }

    const oldRows = rowTokens(source, oldStart, oldEnd);
    const newRows = rowTokens(target, newStart, newEnd);
    let oldIdentity = -1;
    let newIdentity = -1;
    if (eofSpan && oldCount !== newCount) {
      const { sourceStart, targetStart, length } = eofSpan;
      if (oldCount > newCount) {
        const row = copiedEofBody(target, source, targetStart, sourceStart, length);
        if (row !== undefined && row >= oldStart) {
          oldIdentity = row - oldStart;
          newIdentity = newCount - 1;
        }
      } else {
        const row = copiedEofBody(source, target, sourceStart, targetStart, length);
        if (row !== undefined && row >= newStart) {
          oldIdentity = oldCount - 1;
          newIdentity = row - newStart;
        }
      }
    }
    // A proven row must not compare equal to an unrelated occurrence of the same text.
    const identity = Symbol();
    if (oldIdentity >= 0) oldRows[oldIdentity] = newRows[newIdentity] = identity;
    const parts = diffArrays(oldRows, newRows, {
      comparator: sameRow,
      maxEditLength: MAX_ALIGNMENT_EDITS,
    });
    if (
      parts &&
      (oldIdentity < 0 ||
        parts.some((part) => !part.added && !part.removed && part.value.includes(identity)))
    ) {
      for (const part of parts) {
        if (part.removed) emitChange("-", part.count);
        else if (part.added) emitChange("+", part.count);
        else equalRows += part.count;
      }
      return;
    }

    // Keep proven identity even if the search is exhausted or its shortest path skips the pair.
    if (oldIdentity >= 0) {
      emitBlock(0, oldIdentity, 0, newIdentity);
      equalRows++;
      emitBlock(oldIdentity + 1, oldCount, newIdentity + 1, newCount);
    } else {
      emitBlock(0, oldCount, 0, newCount);
    }

    function emitBlock(fromOld: number, toOld: number, fromNew: number, toNew: number) {
      const commonLimit = Math.min(toOld - fromOld, toNew - fromNew);
      let prefix = 0;
      while (prefix < commonLimit && sameRow(oldRows[fromOld + prefix], newRows[fromNew + prefix]))
        prefix++;
      let suffix = 0;
      while (
        suffix < commonLimit - prefix &&
        sameRow(oldRows[toOld - suffix - 1], newRows[toNew - suffix - 1])
      )
        suffix++;
      equalRows += prefix;
      emitChange("-", toOld - fromOld - prefix - suffix);
      emitChange("+", toNew - fromNew - prefix - suffix);
      equalRows += suffix;
    }
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
  diffGap(source.length, target.length, copied.at(-1));
  flushEqual(false);
  return output.join("\n");
}

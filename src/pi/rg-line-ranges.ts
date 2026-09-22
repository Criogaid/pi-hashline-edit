import { mergeRanges, type HalfOpenRange } from "../core/ranges.ts";

export type LineRange = HalfOpenRange;

export interface RgSubmatch {
  start: number;
  end: number;
}

function assertRange(range: LineRange): void {
  if (!Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[1] <= range[0]) {
    throw new Error("Invalid physical line range");
  }
}

export function normalizeRanges(ranges: readonly LineRange[]): LineRange[] {
  for (const range of ranges) assertRange(range);
  return mergeRanges(ranges);
}

export function unionRanges(left: readonly LineRange[], right: readonly LineRange[]): LineRange[] {
  return normalizeRanges([...left, ...right]);
}

export function intersectRanges(left: readonly LineRange[], right: readonly LineRange[]): LineRange[] {
  const a = normalizeRanges(left);
  const b = normalizeRanges(right);
  const result: LineRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (start < end) result.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return result;
}

export function subtractRanges(left: readonly LineRange[], right: readonly LineRange[]): LineRange[] {
  const source = normalizeRanges(left);
  const removed = normalizeRanges(right);
  const result: LineRange[] = [];
  let j = 0;
  for (const [start, end] of source) {
    let cursor = start;
    while (j < removed.length && removed[j][1] <= cursor) j++;
    let k = j;
    while (k < removed.length && removed[k][0] < end) {
      if (removed[k][0] > cursor) result.push([cursor, Math.min(removed[k][0], end)]);
      cursor = Math.max(cursor, removed[k][1]);
      if (cursor >= end) break;
      k++;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

function countLfBefore(bytes: Buffer, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset; i++) if (bytes[i] === 10) count++;
  return count;
}

function zeroWidthLine(bytes: Buffer, offset: number, eventStartLine: number, fileLineCount: number): number | undefined {
  if (fileLineCount === 0) return undefined;
  const candidate = eventStartLine + countLfBefore(bytes, offset);
  return Math.min(candidate, fileLineCount);
}

/** Convert rg byte offsets to physical line ranges; optionally record a match's UTF-16 column on its starting line. */
export function submatchesToLineRanges(
  bytes: Buffer,
  eventStartLine: number,
  submatches: readonly RgSubmatch[],
  fileLineCount: number,
  columns?: Map<number, number>,
): LineRange[] {
  if (!Number.isSafeInteger(eventStartLine) || eventStartLine < 1 || !Number.isSafeInteger(fileLineCount) || fileLineCount < 0) {
    throw new Error("Invalid rg physical line metadata");
  }
  const ranges: LineRange[] = [];
  const recordColumn = (line: number, offset: number) => {
    if (!columns || columns.has(line)) return;
    const lineStart = offset === 0 ? 0 : bytes.lastIndexOf(10, offset - 1) + 1;
    columns.set(line, bytes.subarray(lineStart, offset).toString("utf8").length);
  };
  for (const submatch of submatches) {
    const { start, end } = submatch;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length) {
      throw new Error("Invalid rg submatch byte offsets");
    }
    if (start === end) {
      const line = zeroWidthLine(bytes, start, eventStartLine, fileLineCount);
      if (line !== undefined) {
        ranges.push([line, line + 1]);
        const offset = eventStartLine + countLfBefore(bytes, start) > fileLineCount ? Math.max(0, start - 1) : start;
        recordColumn(line, offset);
      }
      continue;
    }
    const first = eventStartLine + countLfBefore(bytes, start);
    const last = eventStartLine + countLfBefore(bytes, end - 1);
    if (first <= fileLineCount) {
      ranges.push([first, Math.min(last, fileLineCount) + 1]);
      recordColumn(first, start);
    }
  }
  return normalizeRanges(ranges);
}

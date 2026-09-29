import { mergeRanges, type HalfOpenRange } from "../core/ranges.ts";
import { searchChangedError } from "./error-text.ts";

interface RgSubmatch {
  start: number;
  end: number;
}

function countLfBefore(lineBreaks: readonly number[], offset: number): number {
  let low = 0;
  let high = lineBreaks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineBreaks[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Map rg's byte offsets in a multiline JSON event to existing physical lines. */
export function submatchesToLineRanges(
  bytes: Buffer,
  eventStartLine: number,
  submatches: readonly RgSubmatch[],
  fileLineCount: number,
  columns?: Map<number, number>,
): HalfOpenRange[] {
  if (
    !Number.isSafeInteger(eventStartLine) ||
    eventStartLine < 1 ||
    !Number.isSafeInteger(fileLineCount) ||
    fileLineCount < 0
  ) {
    throw new Error("Invalid rg physical line metadata");
  }
  const ranges: HalfOpenRange[] = [];
  const lineBreaks: number[] = [];
  let at = 0;
  while ((at = bytes.indexOf(10, at)) !== -1) {
    lineBreaks.push(at);
    at++;
  }
  const recordColumn = (line: number, offset: number) => {
    if (!columns || columns.has(line)) return;
    const lineStart = offset === 0 ? 0 : bytes.lastIndexOf(10, offset - 1) + 1;
    columns.set(line, bytes.subarray(lineStart, offset).toString("utf8").length);
  };
  for (const { start, end } of submatches) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > bytes.length
    ) {
      throw new Error("Invalid rg submatch byte offsets");
    }
    if (start === end) {
      if (fileLineCount === 0) continue;
      const line = eventStartLine + countLfBefore(lineBreaks, start);
      if (line > fileLineCount) throw searchChangedError();
      ranges.push([line, line + 1]);
      recordColumn(line, start);
      continue;
    }
    const first = eventStartLine + countLfBefore(lineBreaks, start);
    const last = eventStartLine + countLfBefore(lineBreaks, end - 1);
    if (first > fileLineCount || last > fileLineCount) {
      throw searchChangedError();
    }
    ranges.push([first, last + 1]);
    recordColumn(first, start);
  }
  return mergeRanges(ranges);
}

/** JavaScript matching on the LF view, returning bounded physical rows rather than match objects. */
import { normalizeLineEndings } from "./lines.ts";
import { buildRegex } from "./replace.ts";
import type { SearchResult } from "./search-schema.ts";

/** README's grep flags default links here; explicit flags replace this default. */
export const DEFAULT_GREP_FLAGS = "m";

export interface GrepQuery {
  readonly patterns: readonly string[];
  readonly literal: boolean;
  readonly flags: string;
  readonly multiline: boolean;
}
export interface SearchInput {
  readonly source: string;
  readonly query: GrepQuery;
  readonly limit: number;
}
type Rows = SearchResult["lines"];

function mergeRows(left: Rows, right: Rows, limit: number): Rows {
  const result: Rows = [];
  let a = 0;
  let b = 0;
  while (result.length < limit && (a < left.length || b < right.length)) {
    if (b === right.length || (a < left.length && left[a].lineNumber < right[b].lineNumber))
      result.push(left[a++]);
    else if (a === left.length || right[b].lineNumber < left[a].lineNumber) result.push(right[b++]);
    else {
      result.push({
        lineNumber: left[a].lineNumber,
        column: Math.min(left[a++].column, right[b++].column),
      });
    }
  }
  return result;
}

function multilineRows(source: string, regex: RegExp, limit: number): Rows {
  const rows: Rows = [];
  let lineNumber = 1;
  let lineStart = 0;
  let nextBreak = source.indexOf("\n");
  for (const match of source.matchAll(regex)) {
    // A trailing separator terminates the last physical line; it does not create another.
    if (match.index === source.length && (source.length === 0 || source.endsWith("\n"))) break;
    const last = match.index + Math.max(0, match[0].length - 1);
    while (nextBreak !== -1 && nextBreak < match.index) {
      lineStart = nextBreak + 1;
      lineNumber++;
      nextBreak = source.indexOf("\n", lineStart);
    }
    for (;;) {
      if (rows.at(-1)?.lineNumber !== lineNumber) {
        rows.push({ lineNumber, column: Math.max(0, match.index - lineStart) });
        if (rows.length === limit) return rows;
      }
      if (nextBreak === -1 || nextBreak >= last) break;
      lineStart = nextBreak + 1;
      lineNumber++;
      nextBreak = source.indexOf("\n", lineStart);
    }
  }
  return rows;
}

/** Inputs have passed the tool boundary; RegExp owns all syntax and matching semantics. */
export function searchText({ source: raw, query, limit }: SearchInput): SearchResult {
  const source = normalizeLineEndings(raw);
  const regexes = query.patterns.map((pattern) => buildRegex(pattern, !query.literal, query.flags));
  let totalLines = 0;
  for (let start = 0; start < source.length; ) {
    totalLines++;
    const end = source.indexOf("\n", start);
    if (end === -1) break;
    start = end + 1;
  }
  let lines: Rows = [];
  if (query.multiline) {
    for (const regex of regexes)
      lines = mergeRows(lines, multilineRows(source, regex, limit), limit);
  } else {
    for (
      let start = 0, lineNumber = 1;
      start < source.length && lines.length < limit;
      lineNumber++
    ) {
      const separator = source.indexOf("\n", start);
      const end = separator === -1 ? source.length : separator;
      const text = source.slice(start, end);
      let column = Infinity;
      for (const regex of regexes) {
        regex.lastIndex = 0;
        const match = regex.exec(text);
        if (match) column = Math.min(column, match.index);
      }
      if (column !== Infinity) lines.push({ lineNumber, column });
      start = end + 1;
    }
  }
  return { lines, totalLines };
}

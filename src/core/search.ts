/** JavaScript matching on the LF view, returning bounded physical rows rather than match objects. */
import { normalizeLineEndings } from "./lines.ts";
import { buildRegex } from "./regex.ts";
import type { SearchResult } from "./search-schema.ts";

/** Every grep regex uses these flags; ignoreCase adds i. */
export const GREP_FLAGS = "m";

export interface GrepQuery {
  readonly patterns: readonly string[];
  readonly literal: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
}
export interface SearchInput {
  /** Decoded physical lines with original terminators. Multiline needs the whole file.
   * Result line numbers start at 1 in this input, including when line mode receives a subset. */
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

const queryRegexes = ({ patterns, literal, ignoreCase }: GrepQuery) =>
  patterns.map((pattern) =>
    buildRegex(pattern, literal, ignoreCase ? `${GREP_FLAGS}i` : GREP_FLAGS),
  );

/** The first match column of one physical line, or undefined when no pattern matches it. */
function lineColumn(regexes: readonly RegExp[], text: string): number | undefined {
  let column = Infinity;
  for (const regex of regexes) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (match) column = Math.min(column, match.index);
  }
  return column === Infinity ? undefined : column;
}

/** Each line of source, as line feeds separate it, matched alone. */
function lineRows(source: string, regexes: readonly RegExp[], limit: number): Rows {
  const lines: Rows = [];
  for (let start = 0, lineNumber = 1; start < source.length && lines.length < limit; lineNumber++) {
    const separator = source.indexOf("\n", start);
    const end = separator === -1 ? source.length : separator;
    const column = lineColumn(regexes, source.slice(start, end));
    if (column !== undefined) lines.push({ lineNumber, column });
    start = end + 1;
  }
  return lines;
}

/** Inputs have passed the tool boundary; RegExp owns all syntax and matching semantics. */
export function searchText({ source: raw, query, limit }: SearchInput): SearchResult {
  const source = normalizeLineEndings(raw);
  const regexes = queryRegexes(query);
  let lines: Rows = [];
  if (query.multiline) {
    for (const regex of regexes)
      lines = mergeRows(lines, multilineRows(source, regex, limit), limit);
  } else lines = lineRows(source, regexes, limit);
  return { lines };
}

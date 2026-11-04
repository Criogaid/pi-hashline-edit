/**
 * Anchor parsing and row rendering: anchored rows for read, grep, and edit
 * failure diagnostics, plain rows for invalid UTF-8 grep previews, display-row
 * parsing for the grep card, and the carriage-return display shared with
 * mutation diffs.
 *
 * @module pi-hashline-edit/pi
 */

import { computeLineHash, HASH_ALPHABET, HASH_LEN_MIN, HASH_LEN_MAX } from "../core/hash.ts";

const LINE_NUMBER = "([1-9][0-9]*)";

function anchorSource(hashQuantifier: string): string {
  return `${LINE_NUMBER}#([${HASH_ALPHABET}]${hashQuantifier})`;
}

/** Schema pattern for a `LINE#HASH` anchor whose hash has exactly `hashLen` characters. */
export function anchorPattern(hashLen: number): string {
  return `^${anchorSource(`{${hashLen}}`)}$`;
}

/**
 * Separates a row's line reference from its displayed content. Rows are split on LF only, so
 * row and header patterns use `s`: content may hold U+2028 or U+2029, which `.` skips otherwise.
 */
const ROW_SEPARATOR = "│";
const ANCHOR_TOKEN = new RegExp(`^${anchorSource("+")}$`);
const HASHLINE_ROW = new RegExp(
  `^${anchorSource(`{${HASH_LEN_MIN},${HASH_LEN_MAX}}`)}${ROW_SEPARATOR}(.*)$`,
  "s",
);

/** Split a `LINE#HASH` token of any hash length; undefined when the shape is wrong. */
export function parseAnchorToken(value: string): { line: number; hash: string } | undefined {
  const match = ANCHOR_TOKEN.exec(value);
  return match ? { line: Number(match[1]), hash: match[2] } : undefined;
}

interface HashlineRow {
  /** Line number as written in the anchor (string form). */
  lineNo: string;
  /** Line content with the `LINE#HASH│` prefix removed. */
  content: string;
}

/** Parse a display row at any supported hash length; return null for non-anchor text. */
export function parseHashline(line: string): HashlineRow | null {
  const match = HASHLINE_ROW.exec(line);
  return match ? { lineNo: match[1], content: match[3] } : null;
}

const PLAIN_ROW = new RegExp(`^${LINE_NUMBER}${ROW_SEPARATOR}(.*)$`, "s");

/** Parse an anchored row or a non-editable `LINE│content` row; null for other text. */
export function parseDisplayRow(line: string): HashlineRow | null {
  const anchored = parseHashline(line);
  if (anchored) return anchored;
  const match = PLAIN_ROW.exec(line);
  return match ? { lineNo: match[1], content: match[2] } : null;
}

/** Anchor serialization bound to a caller-supplied hash length. */
export interface AnchorFormatter {
  reference(line: number, hash: string): string;
  row(line: number, content: string, displayContent?: string): string;
}

/** Make CR visible without changing the source text used for checksums or patches. */
export function displayCarriageReturns(text: string): string {
  return text.replace(/\r/g, "␍");
}

/** Non-editable `LINE│content` row for text that cannot carry an anchor. */
export function plainRow(line: number, displayContent: string): string {
  return `${line}${ROW_SEPARATOR}${displayCarriageReturns(displayContent)}`;
}

export function createAnchorFormatter(hashLen: number): AnchorFormatter {
  const reference = (line: number, hash: string) => `${line}#${hash}`;
  return {
    reference,
    row: (line, content, displayContent = content) =>
      `${reference(line, computeLineHash(line, content, hashLen))}${ROW_SEPARATOR}${displayCarriageReturns(displayContent)}`,
  };
}

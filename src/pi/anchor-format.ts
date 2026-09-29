import { computeLineHash, HASH_ALPHABET, HASH_LEN_MIN, HASH_LEN_MAX } from "../core/hash.ts";

function anchorSource(hashQuantifier: string): string {
  return `([1-9][0-9]*)#([${HASH_ALPHABET}]${hashQuantifier})`;
}

/** Schema pattern for a `LINE#HASH` anchor whose hash has exactly `hashLen` characters. */
export function anchorPattern(hashLen: number): string {
  return `^${anchorSource(`{${hashLen}}`)}$`;
}

const ANCHOR_TOKEN = new RegExp(`^${anchorSource("+")}$`);
const HASHLINE_ROW = new RegExp(`^${anchorSource(`{${HASH_LEN_MIN},${HASH_LEN_MAX}}`)}│(.*)$`);

/** Split a `LINE#HASH` token of any hash length; undefined when the shape is wrong. */
export function parseAnchorToken(value: string): { line: number; hash: string } | undefined {
  const match = ANCHOR_TOKEN.exec(value);
  return match ? { line: Number(match[1]), hash: match[2]! } : undefined;
}

export interface HashlineRow {
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

/** Anchor serialization bound to a caller-supplied hash length. */
export interface AnchorFormatter {
  reference(line: number, hash: string): string;
  token(line: number, content: string): string;
  row(line: number, content: string, displayContent?: string): string;
}

/** Make CR visible without changing the source text used for checksums or patches. */
export function displayCarriageReturns(text: string): string {
  return text.replace(/\r/g, "␍");
}

export function createAnchorFormatter(hashLen: number): AnchorFormatter {
  const reference = (line: number, hash: string) => `${line}#${hash}`;
  const token = (line: number, content: string) =>
    reference(line, computeLineHash(line, content, hashLen));
  return {
    token,
    reference,
    row: (line, content, displayContent = content) =>
      `${token(line, content)}│${displayCarriageReturns(displayContent)}`,
  };
}

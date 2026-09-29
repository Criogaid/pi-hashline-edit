import { computeLineHash } from "../core/hash.ts";
import { getState } from "./state.ts";

/** Schema pattern for a `LINE#HASH` anchor whose hash has exactly `hashLen` characters. */
export function anchorPattern(hashLen: number): string {
  return `^([1-9][0-9]*)#([0-9A-Z]{${hashLen}})$`;
}

const ANCHOR_TOKEN = /^([1-9][0-9]*)#([0-9A-Z]+)$/;

/** Split a `LINE#HASH` token of any hash length; undefined when the shape is wrong. */
export function parseAnchorToken(value: string): { line: number; hash: string } | undefined {
  const match = ANCHOR_TOKEN.exec(value);
  return match ? { line: Number(match[1]), hash: match[2]! } : undefined;
}

/** Anchor serialization bound to one hash-length snapshot. */
export interface AnchorFormatter {
  readonly hashLen: number;
  reference(line: number, hash: string): string;
  token(line: number, content: string): string;
  row(line: number, content: string, displayContent?: string): string;
}

/** Make CR visible without changing the source text used for checksums or patches. */
export function displayCarriageReturns(text: string): string {
  return text.replace(/\r/g, "␍");
}

export function createAnchorFormatter(hashLen = getState().config.hashLen): AnchorFormatter {
  const reference = (line: number, hash: string) => `${line}#${hash}`;
  const token = (line: number, content: string) =>
    reference(line, computeLineHash(line, content, hashLen));
  return {
    hashLen,
    token,
    reference,
    row: (line, content, displayContent = content) =>
      `${token(line, content)}│${displayCarriageReturns(displayContent)}`,
  };
}

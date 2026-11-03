/** Deterministic Cartesian inputs shared by the pure prefilter and real-rg boundary tests. */
import type { GrepQuery } from "./search.ts";
import type { Prefilter } from "./search-analysis.ts";

export const MATRIX_SYNTAX = [
  ["ASCII literal", "a"],
  ["non-ASCII literal", "é"],
  ["Kelvin folding", "k"],
  ["long-s folding", "s"],
  ["sigma folding", "Σ"],
  ["supplementary literal", "😀"],
  ["high surrogate", "\\uD83D"],
  ["low surrogate", "\\uDE00"],
  ["escaped surrogate pair", "\\uD83D\\uDE00"],
  ["identity escape", "\\K"],
  ["escaped punctuation", "\\."],
  ["control escape", "\\cA"],
  ["hex escape", "\\x61"],
  ["Unicode escape", "\\u0061"],
  ["code-point escape", "\\u{1F600}"],
  ["legacy octal", "\\141"],
  ["legacy decimal escape", "\\8"],
  ["NUL", "\\0"],
  ["LF", "\\n"],
  ["CR", "\\r"],
  ["line separator", "\\u2028"],
  ["paragraph separator", "\\u2029"],
  ["replacement character", "\\uFFFD"],
  ["dot", "."],
  ["positive class", "[a-c]"],
  ["negative class", "[^a]"],
  ["digit", "\\d"],
  ["non-digit", "\\D"],
  ["word", "\\w"],
  ["non-word", "\\W"],
  ["space", "\\s"],
  ["non-space", "\\S"],
  ["start", "^"],
  ["end", "$"],
  ["word boundary", "\\b"],
  ["non-word boundary", "\\B"],
  ["positive lookahead", "(?=a)"],
  ["negative lookahead", "(?!a)"],
  ["positive lookbehind", "(?<=a)"],
  ["negative lookbehind", "(?<!a)"],
  ["unbounded lookbehind", "(?<=a+)b"],
  ["lookbehind capture", "(?<=(a))\\1"],
  ["numeric backreference", "(a)\\1"],
  ["forward backreference", "\\1(a)"],
  ["named backreference", "(?<word>a)\\k<word>"],
  ["unset capture", "(?:(a)|b)\\1"],
  ["alternation", "(?:a|b)"],
  ["empty group", "(?:)"],
  ["add i", "(?i:a)"],
  ["remove i", "(?-i:a)"],
  ["add s", "(?s:.)"],
  ["remove s", "(?-s:.)"],
  ["add m", "(?m:^a$)"],
  ["remove m", "(?-m:^a$)"],
  ["Unicode property", "\\p{Letter}"],
  ["negated Unicode property", "\\P{ASCII}"],
  ["v intersection", "[\\p{ASCII}&&\\p{Letter}]"],
  ["v subtraction", "[\\p{Letter}--[a]]"],
  ["v string alternatives", "[\\q{ab|cd}]"],
  ["v string property", "\\p{RGI_Emoji}"],
] as const;

export const MATRIX_QUANTIFIERS = ["", "?", "*", "+", "*?", "+?", "{0}", "{2}", "{1,3}?"] as const;
export const MATRIX_CONTEXTS = ["bare", "sequence", "alternative", "capture", "OR query"] as const;

/** All combinations of matching flags; d and caller-supplied g are covered at tool entry. */
export const MATRIX_FLAGS = ["", "u", "v"].flatMap((unicode) =>
  Array.from(
    { length: 16 },
    (_, mask) => [..."imsy"].filter((_, bit) => mask & (1 << bit)).join("") + unicode,
  ),
);

export const MATRIX_INPUTS = [
  ["empty", Buffer.alloc(0)],
  ["LF", Buffer.from("a\nb\nab\naa\nxay\nZ\n1\n8\n_\nk\ns\nA\nB\nK\nS\n.\n")],
  ["CRLF", Buffer.from("a\r\nb\r\nab\r\naa\r\nxay\r\nZ\r\n")],
  ["empty lines", Buffer.from("\n\r\n\n")],
  ["Unicode", Buffer.from("é\nÉ\nΣ\nσ\nς\nK\nſ\n😀\n😀😀\nx😀y\n")],
  ["standalone CR", Buffer.from("a\rb\r\r\nZ\r")],
  ["BOM and separators", Buffer.from("\uFEFFa\u2028b\u2029Z\n")],
  ["controls", Buffer.from("\t\f\v\x01 \n")],
  [
    "malformed bytes",
    Buffer.from([0x61, 0xff, 0x62, 0x0d, 0x0a, 0xc3, 0x28, 0x0a, 0xed, 0xa0, 0x80]),
  ],
  ["literal U+FFFD", Buffer.from("a\uFFFDb\n\uFFFD\n")],
  ["unterminated", Buffer.from("ab")],
  ["mixed boundaries", Buffer.from("aa\r\nab\nxay\rZ\n\u2028\u2029😀")],
] as const;

export interface MatrixCase {
  readonly syntax: string;
  readonly quantifier: string;
  readonly context: (typeof MATRIX_CONTEXTS)[number];
  readonly query: GrepQuery;
}

export function* matrixCases(): Generator<MatrixCase> {
  for (const [syntax, atom] of MATRIX_SYNTAX) {
    for (const quantifier of MATRIX_QUANTIFIERS) {
      const part = `(?:${atom})${quantifier}`;
      for (const context of MATRIX_CONTEXTS) {
        const patterns =
          context === "bare"
            ? [part]
            : context === "sequence"
              ? [`x${part}y`]
              : context === "alternative"
                ? [`(?:${part}|Z)`]
                : context === "capture"
                  ? [`(${part})\\1`]
                  : [part, "Z"];
        for (const flags of MATRIX_FLAGS) {
          for (const multiline of [false, true])
            yield {
              syntax,
              quantifier,
              context,
              query: { patterns, flags, multiline, literal: false },
            };
        }
      }
    }
  }
}

export function acceptsNative(query: GrepQuery): boolean {
  try {
    for (const pattern of query.patterns) new RegExp(pattern, query.flags);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Match literal bytes directly, without relying on the candidate regex formatter or expanding products. */
export function hasCandidateBytes(bytes: Buffer, prefilter: Prefilter): boolean {
  if (prefilter.kind === "all") return true;
  return prefilter.literals.some((literal) => {
    const positions = literal.map((chars) => chars.map((char) => Buffer.from(char)));
    for (let start = 0; start < bytes.length; start++) {
      let ends = new Set([start]);
      for (const variants of positions) {
        const next = new Set<number>();
        for (const end of ends)
          for (const variant of variants)
            if (bytes.subarray(end, end + variant.length).equals(variant))
              next.add(end + variant.length);
        ends = next;
        if (!ends.size) break;
      }
      if (ends.size) return true;
    }
    return false;
  });
}

/** Pair every syntax fragment with every other fragment, including independent OR-array entries. */
export function* pairedMatrixCases(): Generator<{ readonly query: GrepQuery }> {
  for (const [, left] of MATRIX_SYNTAX) {
    for (const [, right] of MATRIX_SYNTAX) {
      for (const patterns of [
        [`(?:${left})(?:${right})`],
        [`(?:${left}|${right})`],
        [left, right],
      ]) {
        for (const flags of MATRIX_FLAGS) {
          for (const multiline of [false, true])
            yield { query: { patterns, flags, multiline, literal: false } };
        }
      }
    }
  }
}

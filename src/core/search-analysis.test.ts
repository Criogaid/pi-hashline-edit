import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPrefilter, smartIgnoreCase, type Literal } from "./search-analysis.ts";
import { searchText, type GrepQuery } from "./search.ts";
import { hasCandidateBytes } from "./search-matrix.testing.ts";

const query = (pattern: string, flags = "m", literal = false): GrepQuery => ({
  patterns: [pattern],
  flags,
  literal,
  multiline: true,
});
const literal = (text: string): Literal => [...text].map((char) => [char]);

for (const [pattern, flags, expected] of [
  ["colou?r", "m", [literal("color"), literal("colour")]],
  ["a*", "m", undefined],
  ["(?:word|)", "m", undefined],
  ["[^a]+", "m", undefined],
  ["(?=word)", "m", [literal("word")]],
  ["(?i:a)(?-i:b)", "m", [[["A", "a"], ["b"]]]],
  ["(?-i:a)(?i:b)", "mi", [[["a"], ["B", "b"]]]],
  ["k", "mi", [[["K", "k"]]]],
  ["s", "mi", [[["S", "s"]]]],
  ["k", "miu", [[["K", "k", "K"]]]],
  ["s", "miv", [[["S", "s", "ſ"]]]],
  [
    "abéz",
    "miu",
    [
      [
        ["A", "a"],
        ["B", "b"],
        ["É", "é"],
        ["Z", "z"],
      ],
    ],
  ],
  ["é", "miu", [[["É", "é"]]]],
  ["[\\u0100-\\u0200]", "m", undefined],
] as const) {
  test(`${pattern.slice(0, 80)} /${flags} → conservative candidate literals`, () => {
    assert.deepEqual(
      extractPrefilter(query(pattern, flags)),
      expected ? { kind: "literals", literals: expected } : { kind: "all" },
    );
  });
}

for (const boundary of ["\n", "\r\n", "\uFFFD", "\uD800", "\uDC00", "\0"]) {
  test(`literal ${JSON.stringify(boundary)} boundary → no candidate spans changed bytes`, () => {
    const prefilter = extractPrefilter(query(`left${boundary}xy`, "m", true));
    assert.ok(hasCandidateBytes(Buffer.from(`left${boundary}xy`), prefilter));
    assert.ok(hasCandidateBytes(Buffer.from("left\nxy"), prefilter));
    assert.equal(hasCandidateBytes(Buffer.from("left"), prefilter), false);
    assert.equal(hasCandidateBytes(Buffer.from("xy"), prefilter), false);
    assert.deepEqual(extractPrefilter(query(boundary, "m", true)), { kind: "all" });
  });
}

for (const [patterns, isLiteral, expected, flags] of [
  [["foo", "bar"], false, true],
  [["foo", "Bar"], false, false],
  [["foo\\S*", "\\D", "\\W"], false, true],
  [["\\u0041"], false, false],
  [["\\x41"], false, false],
  [["\\u0061"], false, true],
  [["[A-Z]"], false, false],
  [["(?<UPPER>foo)"], false, true],
  [["ς", "σ"], false, true],
  [["σ", "Σ"], false, false],
  [["foo\\S*"], true, false],
  [["\\u0041"], true, true],
  [["foo", "BAR"], true, false],
  [["\\u{41}"], false, false, "u"],
  [["\\u{41}"], false, false, "v"],
  [["\\u{61}"], false, true, "u"],
  [["\\u{61}"], false, true, "v"],
  [["𐐀"], false, false, "u"],
  [["𐐀"], false, false, "v"],
  [["𐐨"], false, true, "u"],
  [["𐐨"], false, true, "v"],
] as const) {
  test(`${JSON.stringify(patterns)} literal=${isLiteral} flags=${flags ?? ""} → smart case follows decoded letters`, () => {
    assert.equal(smartIgnoreCase(patterns, isLiteral, flags), expected);
  });
}

test("seeded random patterns × raw bytes → a JS hit always retains a candidate byte literal", () => {
  let seed = 0x5eed1234;
  const next = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  const atoms = [
    "a",
    "b",
    "k",
    "s",
    "é",
    "😀",
    "\\n",
    "\\r",
    "\\uFFFD",
    "\\uD83D",
    "[ab]",
    "[^b]",
    "\\w",
    ".",
  ];
  const pieces = [
    Buffer.from("abksABKSéÉKſ😀"),
    Buffer.from("\r\n"),
    Buffer.from("\n"),
    Buffer.from([0xff]),
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xed, 0xa0, 0x80]),
  ];
  const sources = Array.from({ length: 60 }, (_, index) =>
    index % 2 === 0
      ? Buffer.concat(Array.from({ length: 1 + next(8) }, () => pieces[next(pieces.length)]))
      : Buffer.from(Array.from({ length: 1 + next(80) }, () => 1 + next(255))),
  );
  const patterns = [
    "colou?r",
    "a\\uFFFDb",
    "😀",
    "k",
    "s",
    "(?:a|é)?b",
    "a\\nb",
    "[ab]+",
    "(?i:a)(?-i:b)",
  ];
  for (let index = 0; index < 200; index++) {
    const a = atoms[next(atoms.length)];
    const b = atoms[next(atoms.length)];
    patterns.push(
      [`${a}${b}`, `(?:${a}|${b})`, `(?:${a})?${b}`, `(?:${a})+${b}`, `(?=${a})${b}`][next(5)],
    );
  }
  let checkedHits = 0;
  let filteredHits = 0;
  for (const pattern of patterns) {
    for (const flags of ["m", "mi", "miu", "miv"]) {
      // Some generated legacy patterns are invalid in Unicode mode; the real boundary rejects them.
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      for (const multiline of [false, true]) {
        const request = { ...query(pattern, flags), multiline };
        const prefilter = extractPrefilter(request);
        for (const bytes of sources) {
          if (
            !searchText({ source: bytes.toString("utf8"), query: request, limit: 1 }).lines.length
          )
            continue;
          checkedHits++;
          if (prefilter.kind === "all") continue;
          filteredHits++;
          assert.ok(
            hasCandidateBytes(bytes, prefilter),
            JSON.stringify({ pattern, flags, multiline, bytes: bytes.toString("hex"), prefilter }),
          );
        }
      }
    }
  }
  assert.ok(checkedHits > 1000, `Only ${checkedHits} matching cases exercised`);
  assert.ok(filteredHits > 1000, `Only ${filteredHits} filtered matches exercised`);
});

test("oversized literal alternation → retains necessary prefixes without dropping a branch", () => {
  const words = Array.from({ length: 100 }, (_, index) => `word${index}`);
  const prefilter = extractPrefilter(query(words.join("|")));
  for (const word of words) assert.ok(hasCandidateBytes(Buffer.from(word), prefilter));
  assert.equal(hasCandidateBytes(Buffer.from("unrelated"), prefilter), false);
});

test("AND and OR file conditions → retain each alternative and require each conjunction", () => {
  const prefilter = extractPrefilter(query("(?:foo.*bar|baz.*qux)"));
  for (const value of ["foo\nbar", "baz\nqux"])
    assert.ok(hasCandidateBytes(Buffer.from(value), prefilter));
  for (const value of ["foo", "bar", "baz", "qux", "foo\nqux", "baz\nbar"])
    assert.equal(hasCandidateBytes(Buffer.from(value), prefilter), false, value);
});

test("empty expression with a huge repeat → completes without iterating the repeat count", () => {
  assert.deepEqual(extractPrefilter(query("(?:){1000000000}")), { kind: "all" });
});

test("word escape → keeps word-containing files and rejects punctuation-only files", () => {
  const prefilter = extractPrefilter(query("\\w+"));
  assert.ok(hasCandidateBytes(Buffer.from("---a---"), prefilter));
  assert.equal(hasCandidateBytes(Buffer.from("---"), prefilter), false);
});

test("deeply nested uppercase pattern → smart case stays sensitive and prefilter retains native hits", () => {
  for (const depth of [50, 200, 500, 1_000, 2_000, 4_000]) {
    const pattern = `${"(?:".repeat(depth)}A${")".repeat(depth)}`;
    assert.equal(new RegExp(pattern).test("A"), true);
    assert.equal(smartIgnoreCase([pattern], false), false);
    assert.equal(hasCandidateBytes(Buffer.from("A"), extractPrefilter(query(pattern))), true);
  }
});

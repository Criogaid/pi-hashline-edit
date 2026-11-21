import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPrefilter, smartIgnoreCase, type Literal } from "./search-analysis.ts";
import { searchText, type GrepQuery } from "./search.ts";
import { acceptsNative, hasCandidateBytes } from "./search-matrix.testing.ts";

const query = (pattern: string, ignoreCase = false, literal = false): GrepQuery => ({
  patterns: [pattern],
  ignoreCase,
  literal,
  multiline: true,
});
const literal = (text: string): Literal => [...text].map((char) => [char]);

for (const [pattern, ignoreCase, expected] of [
  ["colou?r", false, [literal("color"), literal("colour")]],
  ["a*", false, undefined],
  ["(?:word|)", false, undefined],
  ["[^a]+", false, undefined],
  ["(?=word)", false, [literal("word")]],
  ["(?i:a)(?-i:b)", false, [[["A", "a"], ["b"]]]],
  ["(?-i:a)(?i:b)", true, [[["a"], ["B", "b"]]]],
  ["k", true, [[["K", "k"]]]],
  ["s", true, [[["S", "s"]]]],
  [
    "abéz",
    true,
    [
      [
        ["A", "a"],
        ["B", "b"],
        ["É", "é"],
        ["Z", "z"],
      ],
    ],
  ],
  ["é", true, [[["É", "é"]]]],
  ["[\\u0100-\\u0200]", false, undefined],
  ["foo.*bar", false, [literal("foo")]],
  ["(?:abcdef.*xy|zz.*ghijkl)", false, [literal("abcdef"), literal("ghijkl")]],
  ["foo|bar.*baz", false, [literal("foo"), literal("bar")]],
  ["(?=foo|bar).*baz", false, [literal("baz")]],
] as const) {
  test(`${pattern.slice(0, 80)} ignoreCase=${ignoreCase} → conservative candidate literals`, () => {
    assert.deepEqual(
      extractPrefilter(query(pattern, ignoreCase)),
      expected ? { kind: "literals", literals: expected } : { kind: "all" },
    );
  });
}

for (const boundary of ["\n", "\r\n", "\uFFFD", "\uD800", "\uDC00", "\0"]) {
  test(`literal ${JSON.stringify(boundary)} boundary → no candidate spans changed bytes`, () => {
    const prefilter = extractPrefilter(query(`left${boundary}right`, false, true));
    assert.deepEqual(prefilter, { kind: "literals", literals: [literal("right")] });
    assert.ok(hasCandidateBytes(Buffer.from(`left${boundary}right`), prefilter));
    assert.ok(hasCandidateBytes(Buffer.from("left\nright"), prefilter));
    assert.equal(hasCandidateBytes(Buffer.from("left"), prefilter), false);
    assert.ok(hasCandidateBytes(Buffer.from("right"), prefilter));
    assert.deepEqual(extractPrefilter(query(boundary, false, true)), { kind: "all" });
  });
}

for (const [patterns, isLiteral, expected] of [
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
  [["𐐀+|abc"], false, false],
  [["𐐨+"], false, true],
  [["foo\\S*"], true, false],
  [["\\u0041"], true, true],
  [["foo", "BAR"], true, false],
] as const) {
  test(`${JSON.stringify(patterns)} literal=${isLiteral} → smart case follows decoded letters`, () => {
    assert.equal(smartIgnoreCase(patterns, isLiteral), expected);
  });
}

test("smart case: a supplementary uppercase letter → case-sensitive", () => {
  for (const [pattern, isLiteral] of [
    ["𐐀é", true],
    ["𐐀é", false],
    ["\\uD801\\uDC00", false],
    ["[𐐀]", false],
  ] as const) {
    assert.equal(
      smartIgnoreCase([pattern], isLiteral),
      false,
      `${JSON.stringify(pattern)} literal=${isLiteral}`,
    );
  }
});

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
    for (const ignoreCase of [false, true]) {
      if (!acceptsNative(query(pattern, ignoreCase))) continue;
      for (const multiline of [false, true]) {
        const request = { ...query(pattern, ignoreCase), multiline };
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
            JSON.stringify({
              pattern,
              ignoreCase,
              multiline,
              bytes: bytes.toString("hex"),
              prefilter,
            }),
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

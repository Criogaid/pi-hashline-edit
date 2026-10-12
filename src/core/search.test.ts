import assert from "node:assert/strict";
import { test } from "node:test";
import { searchLines, searchText } from "./search.ts";

const cases = [
  { name: "dot counts UTF-16 units", pattern: "^..$", source: "😀\na\nab\n", lines: [1, 3] },
  {
    name: "negated class counts UTF-16 units",
    pattern: "^[^x]{2}$",
    source: "😀\nab\nx😀\n",
    lines: [1, 2],
  },
  { name: "surrogate half in a class", pattern: "[😀]", source: "😀\nx\n", lines: [1] },
  {
    name: "repeated capture resets",
    pattern: "^(?:(a)|b)+\\1$",
    source: "ab\naba\naa\n",
    lines: [1, 3],
  },
  { name: "unbounded lookbehind", pattern: "(?<=a+)b", source: "aab\nb\n", lines: [1] },
  {
    name: "backwards capture evaluation",
    pattern: "(?<=(a)\\1)b",
    source: "ab\naab\n",
    lines: [1, 2],
  },
  {
    name: "case folding in a referenced capture",
    pattern: "^(é)\\1$",
    source: "éÉ\nÉé\nee\n",
    lines: [1, 2],
    ignoreCase: true,
  },
  {
    name: "CRLF normalized before backreference",
    pattern: "(a\\n)\\1",
    source: "a\r\na\nb\n",
    lines: [1, 2],
    multiline: true,
  },
  {
    name: "empty matches on consecutive empty lines",
    pattern: "(?=^$)",
    source: "\n\r\n\n",
    lines: [1, 2, 3],
    multiline: true,
  },
  {
    name: "match ends before next physical line",
    pattern: "a\\n",
    source: "a\r\nb\n",
    lines: [1],
    multiline: true,
  },
  { name: "line mode excludes separators", pattern: "\\n", source: "a\nb\n", lines: [] },
  { name: "empty file has no physical rows", pattern: "^$", source: "", lines: [] },
  {
    name: "terminal empty match stays on the unterminated physical line",
    pattern: "(?=$)",
    source: "ab",
    lines: [1],
    multiline: true,
  },
  {
    name: "scoped flags stay native",
    pattern: "^(?i:a)(?-i:b)$",
    source: "Ab\nAB\nab\n",
    lines: [1, 3],
  },
];
for (const scenario of cases) {
  test(`JS search: ${scenario.name}`, () => {
    const result = searchText({
      source: scenario.source,
      query: {
        patterns: [scenario.pattern],
        literal: false,
        flags: scenario.ignoreCase ? "mi" : "m",
        multiline: scenario.multiline ?? false,
      },
      limit: 100,
    });
    assert.deepEqual(
      result.lines.map(({ lineNumber }) => lineNumber),
      scenario.lines,
    );
  });
}

test("JS search: alternatives merge before the physical row limit", () => {
  const result = searchText({
    source: "zero\na\nb\nc\n",
    query: {
      patterns: ["c", "a\\nb", "(?=b)"],
      literal: false,
      flags: "m",
      multiline: true,
    },
    limit: 2,
  });
  assert.deepEqual(result.lines, [
    { lineNumber: 2, column: 0 },
    { lineNumber: 3, column: 0 },
  ]);
  assert.equal(result.totalLines, 4);
});

test("JS search: columns retain UTF-16 positions inside supplementary characters", () => {
  const result = searchText({
    source: "😀x\n",
    query: { patterns: ["\\uDE00"], literal: false, flags: "m", multiline: false },
    limit: 1,
  });
  assert.deepEqual(result.lines, [{ lineNumber: 1, column: 1 }]);
});

test("selected lines ending in CR → matching preserves the CR and uses 1-based positions", () => {
  const query = { patterns: ["\\r$"], literal: false, flags: "", multiline: false };
  assert.deepEqual(searchLines({ lines: "skip\na\r\nb\r\n", query, limit: 10 }), {
    lines: [
      { lineNumber: 2, column: 1 },
      { lineNumber: 3, column: 1 },
    ],
    totalLines: 3,
  });
});

test("selected lines exceed limit → rows truncate while totalLines counts all lines", () => {
  const query = { patterns: ["a", "b"], literal: true, flags: "", multiline: false };
  assert.deepEqual(searchLines({ lines: "skip\nxa\nb\na\n", query, limit: 1 }), {
    lines: [{ lineNumber: 2, column: 1 }],
    totalLines: 4,
  });
});

test("empty selected input or one empty line → physical totals are zero or one", () => {
  const query = { patterns: ["^$"], literal: false, flags: "", multiline: false };
  for (const [lines, expected] of [
    ["", { lines: [], totalLines: 0 }],
    ["\n", { lines: [{ lineNumber: 1, column: 0 }], totalLines: 1 }],
  ] as const) {
    assert.deepEqual(searchLines({ lines, query, limit: 1 }), expected);
  }
});

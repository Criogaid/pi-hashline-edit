import assert from "node:assert/strict";
import { test } from "node:test";
import { RegexTranslationError, smartIgnoreCase, translateQuery } from "./rg-regex.ts";

const query = (patterns: readonly string[], multiline = false, literal = false) =>
  translateQuery({ patterns, multiline, literal, flags: "m" });

test("grep translation selects PCRE2 for assertions requiring lookaround or backreferences", () => {
  for (const [pattern, engine] of [
    ["^a[bc]+$", "pcre2"],
    ["\\b\\w+", "default"],
    ["\\b\\w+\\B", "pcre2"],
    ["(?<word>a)(?:b|c)", "default"],
    ["(?i:a)(?-i:b)", "default"],
    ["a(?=b)", "pcre2"],
    ["a(?!b)", "pcre2"],
    ["(?<=a)b", "pcre2"],
    ["(?<!a)b", "pcre2"],
    ["(a)\\1", "pcre2"],
    ["\\1(a)", "pcre2"],
    ["(?<word>a)\\k<word>", "pcre2"],
  ] as const) {
    const [matcher] = query([pattern]);
    assert.equal(matcher.engine, engine, pattern);
    assert.equal(matcher.multiline, false, pattern);
  }
  assert.equal(query(["a(?=b)"], false, true)[0].engine, "default");
});

test("grep line queries matching standalone CR enable a multiline scan", () => {
  for (const [patterns, literal] of [
    [["\\r"], false],
    [["needle", "standalone\r"], true],
    [["\\s"], false],
    [["[a\\r]"], false],
  ] as const) {
    const [matcher] = query(patterns, false, literal);
    assert.equal(matcher.multiline, true);
    assert.equal(matcher.engine, "default");
  }
  assert.equal(query(["[a\\t]"])[0].multiline, false);
});

test("grep translation delegates surrogate code units to JavaScript", () => {
  for (const [pattern, literal] of [
    ["\\uD83D", false],
    ["\uD83D", true],
  ] as const) {
    assert.throws(
      () => query([pattern], false, literal),
      (error: unknown) => {
        assert.ok(error instanceof RegexTranslationError);
        assert.match(error.message, /surrogate pair/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => query(["\\n"], true));
  assert.doesNotThrow(() => query(["(?:😀)+"]));
});

test("grep smart case uses decoded characters across the whole query", () => {
  for (const [patterns, literal, expected] of [
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
  ] as const) {
    assert.equal(
      smartIgnoreCase(patterns, literal),
      expected,
      JSON.stringify({ patterns, literal }),
    );
  }
});

test("zero-maximum quantifiers → exclude inert contents from backreference analysis", async (t) => {
  const cases = [
    {
      name: "multiline newline repeated zero times → accepted",
      pattern: "(a\\n{0})\\1",
      multiline: true,
      ignoreCase: false,
      accepted: true,
    },
    {
      name: "caseless non-ASCII text repeated zero times → accepted",
      pattern: "(aé{0})\\1",
      multiline: false,
      ignoreCase: true,
      accepted: true,
    },
    {
      name: "line-mode newline repeated zero times → accepted",
      pattern: "(a\\n{0})\\1",
      multiline: false,
      ignoreCase: false,
      accepted: true,
    },
    {
      name: "caseless self-reference repeated zero times → accepted",
      pattern: "(a(?:\\1){0})\\1",
      multiline: false,
      ignoreCase: true,
      accepted: true,
    },
    {
      name: "multiline newline repeated up to once → rejected",
      pattern: "(a\\n{0,1})\\1",
      multiline: true,
      ignoreCase: false,
      accepted: false,
    },
  ];
  for (const { name, pattern, multiline, ignoreCase, accepted } of cases) {
    await t.test(name, () => {
      const translate = () =>
        translateQuery({
          patterns: [pattern],
          literal: false,
          multiline,
          flags: ignoreCase ? "mi" : "m",
        });
      if (accepted) assert.doesNotThrow(translate);
      else assert.throws(translate, RegexTranslationError);
    });
  }
});

test("strict JS translation rejects constructs with different code-unit or capture semantics", () => {
  for (const pattern of [
    ".",
    "[^a]",
    "[\\s\\S]",
    "[😀]",
    "(?:(a)|b)+\\1",
    "(?<=(a)\\1)b",
    "(?<=(a))b\\1",
  ]) {
    assert.throws(() => query([pattern]), RegexTranslationError, pattern);
  }
  for (const pattern of ["[\\u0001-\\uD7FF\\uE000-\\uFFFF]", "(?:😀)+", ".{0}a", "(a)\\1"]) {
    assert.doesNotThrow(() => query([pattern]), pattern);
  }
});

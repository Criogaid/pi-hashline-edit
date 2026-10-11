import assert from "node:assert/strict";
import { test } from "node:test";
import { RegexTranslationError, smartIgnoreCase, translateQuery } from "./rg-regex.ts";

const query = (patterns: readonly string[], multiline = false, literal = false) =>
  translateQuery({ patterns, multiline, literal, ignoreCase: false });

test("grep translation selects PCRE2 only for lookaround or backreferences", () => {
  for (const [pattern, engine] of [
    ["^a[bc]+$", "default"],
    ["\\b\\w+\\B", "default"],
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
  ] as const) {
    const [matcher] = query(patterns, false, literal);
    assert.equal(matcher.multiline, true);
    assert.equal(matcher.engine, "default");
  }
  for (const pattern of ["\\s", "[^a]"])
    assert.equal(query([pattern])[0].multiline, false, pattern);
});

test("grep translation rejects line breaks and lone surrogates with actionable fixes", () => {
  for (const [pattern, literal, reason, fix] of [
    ["\\n", false, /each line.*line break/, /multiline.*true/],
    ["\n", true, /each line.*line break/, /multiline.*true/],
    ["\\uD83D", false, /surrogate pair/, /whole characters.*group/],
    ["\uD83D", true, /surrogate pair/, /whole characters.*group/],
  ] as const) {
    assert.throws(
      () => query([pattern], false, literal),
      (error: unknown) => {
        assert.ok(error instanceof RegexTranslationError);
        assert.match(error.message, reason);
        assert.match(error.fix ?? "", fix);
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

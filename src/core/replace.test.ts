import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReplacements } from "./replace.ts";
import type { Replacement } from "./replace-schema.ts";
import { HashlineError } from "./errors.ts";

test("replacement at the file start → retains the original BOM at byte zero", async (t) => {
  const cases = [
    {
      name: "zero-width insertion",
      source: "\uFEFFfoo\r\nbar\n",
      find: "^",
      replace: "X",
      expected: "\uFEFFXfoo\r\nbar\n",
    },
    {
      name: "whole-file replacement",
      source: "\uFEFFfoo",
      find: "^[\\s\\S]*$",
      replace: "X",
      expected: "\uFEFFX",
    },
    { name: "copied BOM", source: "\uFEFFfoo", find: "^.", replace: "$&X", expected: "\uFEFFXfoo" },
    { name: "consumed BOM", source: "\uFEFFfoo", find: "^.", replace: "", expected: "\uFEFFfoo" },
    {
      name: "inserted body BOM",
      source: "\uFEFFfoo",
      find: "^",
      replace: "\uFEFF",
      expected: "\uFEFF\uFEFFfoo",
    },
    {
      name: "capture copied into body",
      source: "\uFEFFfoo",
      find: "^(.*)",
      replace: "X$1",
      expected: "\uFEFFX\uFEFFfoo",
    },
    { name: "BOM-only file", source: "\uFEFF", find: "^", replace: "X", expected: "\uFEFFX" },
    {
      name: "body BOM",
      source: "foo\uFEFFbar",
      find: "^",
      replace: "X",
      expected: "Xfoo\uFEFFbar",
    },
    {
      name: "literal replacement starts with an explicit U+FEFF",
      source: "\uFEFFa",
      find: "\uFEFF",
      literal: true,
      replace: "\uFEFFX",
      expected: "\uFEFF\uFEFFXa",
    },
    {
      name: "regex replacement starts with an explicit U+FEFF before a copy of the header",
      source: "\uFEFFa",
      find: "^.",
      replace: "\uFEFF$&X",
      expected: "\uFEFF\uFEFF\uFEFFXa",
    },
    {
      name: "leading numbered capture copies a body U+FEFF",
      source: "\uFEFF\uFEFFa",
      find: "^.(.)",
      replace: "$1X",
      expected: "\uFEFF\uFEFFXa",
    },
    {
      name: "leading named capture copies a body U+FEFF",
      source: "\uFEFF\uFEFFa",
      find: "^.(?<body>.)",
      replace: "$<body>X",
      expected: "\uFEFF\uFEFFXa",
    },
    {
      name: "only the first emitted copy of the header is reused after an empty capture",
      source: "\uFEFFa",
      find: "^(x)?(.)",
      replace: "$1$2$2X",
      expected: "\uFEFF\uFEFFXa",
    },
    {
      name: "a leading named capture of the header reuses the original BOM",
      source: "\uFEFFa",
      find: "^(?<header>.)",
      replace: "$<header>X",
      expected: "\uFEFFXa",
    },
    {
      name: "two-digit fallback copies the header through capture one",
      source: "\uFEFFa",
      find: "^(.)",
      flags: "d",
      replace: "$12",
      expected: "\uFEFF2a",
    },
  ];
  for (const { name, source, find, replace, expected, literal = false, flags } of cases) {
    await t.test(name, () => {
      const { text, count } = applyReplacements(source, [{ literal, find, replace, flags }]);
      assert.equal(text, expected);
      assert.equal(count, 1);
    });
  }
});

test("replacement joins beside LF → preserve standalone CR content", async (t) => {
  const literal = (find: string, replace: string): Replacement => ({
    find,
    replace,
    literal: true,
  });
  const cases = [
    {
      name: "replacement before original LF",
      source: "a\nb",
      rules: [literal("a", "x\r")],
      expected: "x\r\r\nb",
    },
    {
      name: "original CR before replacement LF",
      source: "a\rb",
      rules: [literal("b", "\nB")],
      expected: "a\r\r\nB",
    },
    {
      name: "deletion joins original CR and LF",
      source: "a\rx\nb",
      rules: [literal("x", "")],
      expected: "a\r\r\nb",
    },
    {
      name: "replacement contains CR before a new LF",
      source: "a\nb",
      rules: [literal("a", "x\r\r\ny")],
      expected: "x\r\r\ny\nb",
    },
    {
      name: "replacement contains CR before a reused LF",
      source: "a\nb",
      rules: [literal("a\nb", "x\r\r\ny")],
      expected: "x\r\r\ny",
    },
    {
      name: "captured CR before replacement LF",
      source: "a\rb\nc",
      rules: [{ find: "(a\r)b", replace: "$1\nB", literal: false }],
      expected: "a\r\r\nB\nc",
    },
    {
      name: "adjacent replacements",
      source: "ab",
      rules: [literal("a", "x\r"), literal("b", "\ny")],
      expected: "x\r\r\ny",
    },
    {
      name: "adjacent replacements separated by a deletion",
      source: "axb",
      rules: [literal("a", "x\r"), literal("x", ""), literal("b", "\ny")],
      expected: "x\r\r\ny",
    },
    {
      name: "zero-width insertion before LF",
      source: "a\nb",
      rules: [{ find: "(?=\\n)", replace: "\r", literal: false }],
      expected: "a\r\r\nb",
    },
    {
      name: "replacement before original CRLF",
      source: "a\r\nb",
      rules: [literal("a", "x\r")],
      expected: "x\r\r\nb",
    },
    {
      name: "unchanged CR content and CRLF separator",
      source: "a\r\r\nb",
      rules: [literal("a\r\r\nb", "a\r\r\nb")],
      expected: "a\r\r\nb",
    },
    {
      name: "CR at EOF needs no separator",
      source: "ab",
      rules: [literal("b", "x\r")],
      expected: "ax\r",
    },
  ];
  for (const { name, source, rules, expected } of cases) {
    await t.test(name, () => {
      assert.equal(applyReplacements(source, rules).text, expected);
    });
  }
});

test("replacement adds CR at a copied LF boundary → copied spans use raw UTF-16 offsets", () => {
  const result = applyReplacements("\uFEFF🙂\r\nleft\rX\nright", [
    { find: "(X)", replace: "$1\r", literal: false },
  ]);
  assert.equal(result.text, "\uFEFF🙂\r\nleft\rX\r\r\nright");
  assert.deepEqual(result.copied, [
    { sourceStart: 0, targetStart: 0, length: 10 },
    { sourceStart: 11, targetStart: 13, length: 6 },
  ]);
});

test("whole-file literal replacement with equal text → no copied span", () => {
  const result = applyReplacements("same", [{ find: "same", replace: "same", literal: true }]);
  assert.equal(result.text, "same");
  assert.deepEqual(result.copied, []);
});

test("replacement rejection → reports all unmatched rules or the conflicting rule pair and line", async (t) => {
  const literal = (find: string): Replacement => ({ find, replace: "x", literal: true });
  const cases = [
    {
      name: "multiple unmatched rules",
      source: "present",
      rules: [literal("missing"), literal("present"), literal("absent")],
      code: "NO_MATCH",
      message: "Rules match nothing in the file.",
      facts: { unmatched: ["replacements[0]", "replacements[2]"] },
    },
    ...["\n", "\r\n"].map((eol) => ({
      name: `overlap in reversed input order with ${JSON.stringify(eol)}`,
      source: `head${eol}abcd${eol}tail`,
      rules: [literal("cd"), literal("bc")],
      code: "OVERLAPPING_MATCHES",
      message: "Matches of two rules overlap.",
      facts: { conflict: ["replacements[0]", "replacements[1]"], line: 2 },
    })),
    {
      name: "overlap on first line",
      source: "abcd",
      rules: [literal("ab"), literal("bc")],
      code: "OVERLAPPING_MATCHES",
      message: "Matches of two rules overlap.",
      facts: { conflict: ["replacements[0]", "replacements[1]"], line: 1 },
    },
  ];
  for (const { name, source, rules, code, message, facts } of cases) {
    await t.test(name, () => {
      assert.throws(
        () => applyReplacements(source, rules),
        (error: unknown) => {
          assert.ok(error instanceof HashlineError);
          assert.equal(error.errorCode, code);
          assert.equal(error.message, message);
          assert.deepEqual(error.facts, facts);
          return true;
        },
      );
    });
  }
});

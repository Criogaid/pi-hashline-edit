import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReplacements, type Replacement } from "./replace.ts";

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

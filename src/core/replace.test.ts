import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReplacements, type Replacement } from "./replace.ts";
import { HashlineError } from "./errors.ts";

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

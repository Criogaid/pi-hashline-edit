import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLfTextView,
  normalizeLineEndings,
  splitLines,
  sliceLines,
  detectLineEnding,
  hasFinalNewline,
} from "./lines.ts";

test("splitLines edge cases", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("splitLines strips CRLF \\r", () => {
  assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
});

test("splitLines handles mixed line endings and standalone CR correctly", () => {
  assert.deepEqual(splitLines("a\r\nb\nc\r\n"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("a\rb\r\n"), ["a\rb"]);
  assert.deepEqual(splitLines("a\rb\nc"), ["a\rb", "c"]);
  assert.deepEqual(splitLines("\r\n"), [""]);
  assert.deepEqual(splitLines("\r\n\r\n"), ["", ""]);
  assert.deepEqual(splitLines("a\r\n\r\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines("a\r\n\r\n"), ["a", ""]);
});

test("hasFinalNewline", () => {
  assert.equal(hasFinalNewline("a\nb"), false);
  assert.equal(hasFinalNewline("a\nb\n"), true);
  assert.equal(hasFinalNewline("a\r\nb"), false);
  assert.equal(hasFinalNewline("a\r\nb\r\n"), true);
  assert.equal(hasFinalNewline("a"), false);
  // no lines, no terminator — rejoining [] yields "" either way
  assert.equal(hasFinalNewline(""), true);
});

test("detectLineEnding", () => {
  assert.equal(detectLineEnding("a\nb\n"), "lf");
  assert.equal(detectLineEnding("a\r\nb\r\n"), "crlf");
  assert.equal(detectLineEnding("a\nb\r\nc\n"), "crlf");
});

test("LF views map every UTF-16 boundary back to original CRLF bytes", () => {
  for (const source of ["", "a\nb", "\uFEFF😀\r\nb\nc\r\n", "\r\n\r\n", "a\rb\r\r\nc"]) {
    const view = createLfTextView(source);
    assert.equal(view.text, normalizeLineEndings(source));
    assert.equal(view.sourceOffset(view.text.length), source.length);
    for (let offset = 0; offset <= view.text.length; offset++) {
      assert.equal(
        normalizeLineEndings(source.slice(0, view.sourceOffset(offset))),
        view.text.slice(0, offset),
      );
    }
  }
});

test("sliceLines matches splitLines across empty, single-line, multiline, CRLF, and ranges", () => {
  const fixtures = [
    "",
    "a",
    "a\n",
    "a\nb",
    "a\nb\n",
    "a\n\n",
    "\n",
    "\n\n",
    "a\r\nb\r\n",
    "a\r\nb",
    "a\r\n\r\n",
    "a\r\n\r\nb",
    "a\rb\r\n",
    "a\rb\nc",
    "line1\nline2\nline3\nline4\nline5\n",
    "line1\r\nline2\r\nline3\r\nline4\r\nline5",
  ];

  for (const text of fixtures) {
    const expectedFull = splitLines(text);
    const ranges = [
      [0, expectedFull.length],
      [0, 2],
      [1, 3],
      [2, 2],
      [0, 0],
      [0, 100],
      [3, 100],
    ];
    for (const [start, end] of ranges) {
      const result = sliceLines(text, start, end);
      assert.equal(
        result.totalLines,
        expectedFull.length,
        `totalLines mismatch for ${JSON.stringify(text)}`,
      );
      assert.deepEqual(
        result.lines,
        expectedFull.slice(start, end),
        `lines mismatch for range [${start}, ${end}) on ${JSON.stringify(text)}`,
      );
    }
  }
});

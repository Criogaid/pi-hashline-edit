import { test } from "node:test";
import assert from "node:assert/strict";
import { createLfTextView, normalizeLineEndings, splitLines, detectLineEnding, hasFinalNewline } from "./lines.ts";

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
			assert.equal(normalizeLineEndings(source.slice(0, view.sourceOffset(offset))), view.text.slice(0, offset));
		}
	}
});

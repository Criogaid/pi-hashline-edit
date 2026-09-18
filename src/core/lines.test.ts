import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, detectLineEnding, hasFinalNewline } from "./lines.ts";

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

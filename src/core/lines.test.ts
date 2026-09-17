import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, joinLines, detectLineEnding, hasFinalNewline } from "./lines.ts";

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

test("joinLines restores line endings", () => {
	assert.equal(joinLines(["a", "b"]), "a\nb\n");
	assert.equal(joinLines([]), "");
	assert.equal(joinLines(["a", "b"], "crlf"), "a\r\nb\r\n");
	assert.equal(joinLines(["a", "b"], "lf"), "a\nb\n");
});

test("joinLines preserves the final-newline state when told to", () => {
	assert.equal(joinLines(["a", "b"], "lf", false), "a\nb");
	assert.equal(joinLines(["a", "b"], "crlf", false), "a\r\nb");
	assert.equal(joinLines(["a"], "lf", false), "a");
	assert.equal(joinLines([], "lf", false), "");
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

test("split/join round-trips a document byte for byte", () => {
	for (const text of ["a", "a\n", "a\nb", "a\nb\n", "a\n\n", "\n", "a\r\nb", "a\r\nb\r\n", ""]) {
		assert.equal(joinLines(splitLines(text), detectLineEnding(text), hasFinalNewline(text)), text);
	}
});

test("detectLineEnding", () => {
	assert.equal(detectLineEnding("a\nb\n"), "lf");
	assert.equal(detectLineEnding("a\r\nb\r\n"), "crlf");
	assert.equal(detectLineEnding("a\nb\r\nc\n"), "crlf");
});

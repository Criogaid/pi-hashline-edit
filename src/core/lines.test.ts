import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, joinLines, detectLineEnding } from "./lines.ts";

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

test("detectLineEnding", () => {
	assert.equal(detectLineEnding("a\nb\n"), "lf");
	assert.equal(detectLineEnding("a\r\nb\r\n"), "crlf");
	assert.equal(detectLineEnding("a\nb\r\nc\n"), "crlf");
});

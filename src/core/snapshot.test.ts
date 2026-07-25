import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, joinLines, createSnapshot, verifyAnchor } from "./snapshot.ts";

test("splitLines 边界", () => {
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(splitLines("a"), ["a"]);
	assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
	assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
	assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
	assert.deepEqual(splitLines("\n"), [""]);
});

test("splitLines 去掉 CRLF 的 \\r", () => {
	assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
	assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
});

test("joinLines 行尾恢复", () => {
	assert.equal(joinLines(["a", "b"]), "a\nb\n");
	assert.equal(joinLines([]), "");
	assert.equal(joinLines(["a", "b"], "crlf"), "a\r\nb\r\n");
	assert.equal(joinLines(["a", "b"], "lf"), "a\nb\n");
});

test("createSnapshot 记录 path/text/hashLen", () => {
	const s = createSnapshot("f.ts", "a\nb\nc\n");
	assert.equal(s.path, "f.ts");
	assert.equal(s.text, "a\nb\nc\n");
	assert.equal(s.lineHashes.length, 3);
	assert.equal(s.hashLen, 4);
});

test("createSnapshot 自定义 hashLen", () => {
	assert.equal(createSnapshot("f", "a\n", 6).hashLen, 6);
});

test("createSnapshot 记录 lineEnding", () => {
	assert.equal(createSnapshot("f", "a\nb\n").lineEnding, "lf");
	assert.equal(createSnapshot("f", "a\r\nb\r\n").lineEnding, "crlf");
});

test("verifyAnchor 匹配", () => {
	const s = createSnapshot("f", "a\nb\n");
	assert.deepEqual(verifyAnchor(s, { line: 2, hash: s.lineHashes[1] }), { ok: true, line: 2 });
});

test("verifyAnchor hash_not_found", () => {
	const s = createSnapshot("f", "a\nb\n");
	const r = verifyAnchor(s, { line: 1, hash: "ZZZZ" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error, "hash_not_found");
});

test("verifyAnchor line_mismatch（漂移）", () => {
	const s = createSnapshot("f", "a\nb\n");
	const r = verifyAnchor(s, { line: 1, hash: s.lineHashes[1] });
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error, "line_mismatch");
});

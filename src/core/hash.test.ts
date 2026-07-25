import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash, hashFileLines } from "./hash.ts";

const ALLOWED = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");

test("computeLineHash 稳定且为 base32", () => {
	const a = computeLineHash("p", "c", "n", 4);
	const b = computeLineHash("p", "c", "n", 4);
	assert.equal(a, b);
	assert.equal(a.length, 4);
	for (const ch of a) assert.ok(ALLOWED.has(ch), `bad char ${ch}`);
});

test("context-aware：相同行不同邻居 → 不同 hash", () => {
	const h1 = computeLineHash("a", "x", "b");
	const h2 = computeLineHash("c", "x", "d");
	assert.notEqual(h1, h2);
});

test("context-aware：相同三元组 → 相同 hash", () => {
	assert.equal(computeLineHash("a", "x", "b"), computeLineHash("a", "x", "b"));
});

test("base32 字符集（去 I/L/O/U）批量", () => {
	for (let i = 0; i < 2000; i++) {
		const h = computeLineHash("", `line ${i}`, "", 4);
		for (const ch of h) assert.ok(ALLOWED.has(ch), `bad char ${ch} in ${h}`);
	}
});

test("hashFileLines 长度等于行数", () => {
	assert.equal(hashFileLines(["a", "b", "c"]).length, 3);
});

test("hashFileLines 空文件", () => {
	assert.deepEqual(hashFileLines([]), []);
});

test("hashFileLines 文件内无碰撞（大量重复行）", () => {
	const lines = ["", "", "", "", "", "}", "}", "}", "return", "return", ",", ","];
	const hashes = hashFileLines(lines);
	assert.equal(new Set(hashes).size, hashes.length, "collision not resolved");
});

test("hashFileLines 长度参数生效", () => {
	assert.equal(hashFileLines(["a", "b"], 6)[0].length, 6);
	assert.equal(hashFileLines(["a", "b"], 4)[0].length, 4);
});

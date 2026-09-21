import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash, hashFileLines } from "./hash.ts";

const ALLOWED = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");

test("computeLineHash is stable and base32", () => {
	const a = computeLineHash(3, "code", 4);
	const b = computeLineHash(3, "code", 4);
	assert.equal(a, b);
	assert.equal(a.length, 4);
	for (const ch of a) assert.ok(ALLOWED.has(ch), `bad char ${ch}`);
});

test("different line number → different hash (even for identical content)", () => {
	assert.notEqual(computeLineHash(2, ""), computeLineHash(5, ""));
	assert.notEqual(computeLineHash(1, "}"), computeLineHash(2, "}"));
});

test("different content → different hash", () => {
	assert.notEqual(computeLineHash(1, "a"), computeLineHash(1, "b"));
});

test("same (line, content) → same hash", () => {
	assert.equal(computeLineHash(7, "x"), computeLineHash(7, "x"));
});

test("base32 alphabet (without I/L/O/U) in bulk", () => {
	for (let i = 0; i < 2000; i++) {
		const h = computeLineHash(i + 1, `line ${i}`, 4);
		for (const ch of h) assert.ok(ALLOWED.has(ch), `bad char ${ch} in ${h}`);
	}
});

test("hashFileLines length equals line count", () => {
	assert.equal(hashFileLines(["a", "b", "c"]).length, 3);
});

test("hashFileLines empty file", () => {
	assert.deepEqual(hashFileLines([]), []);
});

test("hashFileLines normally disambiguates repeated content without changing hash length", () => {
	const lines = ["", "", "", "", "", "}", "}", "}", "return", "return", ",", ","];
	const hashes = hashFileLines(lines);
	assert.equal(new Set(hashes).size, hashes.length, "unexpected collision in fixture");
	for (const h of hashes) assert.equal(h.length, 4, `hash ${h} is not 4 chars`);
});

test("truncated checksums can collide", () => {
	assert.equal(computeLineHash(1, "const value = 558;", 4), "TM02");
	assert.equal(computeLineHash(1, "const value = 9344;", 4), "TM02");
});

test("hashFileLines respects the length parameter", () => {
	assert.equal(hashFileLines(["a", "b"], 6)[0].length, 6);
	assert.equal(hashFileLines(["a", "b"], 4)[0].length, 4);
});

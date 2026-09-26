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

test("hashLen 8 has a leading zero due to the 32-bit hash limit", () => {
	for (let i = 1; i <= 20; i++) {
		const h = computeLineHash(i, `content ${i}`, 8);
		assert.equal(h.length, 8);
		assert.equal(h[0], "0");
	}
});

test("computeLineHash produces output identical to hashing full interpolated string", () => {
	function referenceHash(line: number, content: string, len = 4): string {
		let h = 0x811c9dc5;
		const str = `${line}\n${content}`;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		let s = "";
		const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		let n = h >>> 0;
		for (let i = 0; i < len; i++) {
			s = BASE32[n & 31] + s;
			n = n >>> 5;
		}
		return s;
	}
	for (const line of [1, 9, 10, 99, 100, 999, 10000]) {
		for (const content of ["", "a", "function test() {}", "long line with symbols !@#$%^&*()_+-=[]{}|;:,.<>?/`~"]) {
			assert.equal(computeLineHash(line, content, 4), referenceHash(line, content, 4));
			assert.equal(computeLineHash(line, content, 6), referenceHash(line, content, 6));
		}
	}
});



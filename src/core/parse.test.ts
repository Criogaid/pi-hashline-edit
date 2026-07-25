import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch } from "./parse.ts";

test("parse replace single line", () => {
	const r = parsePatch("file: f.ts\n\nreplace 4#ABCD:\n+new line\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.patch.path, "f.ts");
		assert.equal(r.patch.edits.length, 1);
		assert.equal(r.patch.edits[0].op, "replace");
	}
});

test("parse replace range", () => {
	const r = parsePatch("file: f.ts\nreplace 3#AAA..5#BBB:\n+a\n+b\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		const e = r.patch.edits[0];
		if (e.op === "replace") {
			assert.equal(e.start.line, 3);
			assert.equal(e.end?.line, 5);
			assert.deepEqual(e.body, ["a", "b"]);
		}
	}
});

test("parse delete (no body)", () => {
	const r = parsePatch("file: f.ts\ndelete 2#XYZ\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits[0].op, "delete");
});

test("parse insert_after / insert_before", () => {
	const r = parsePatch("file: f.ts\ninsert_after 3#ABC:\n+x\n\ninsert_before 5#DEF:\n+y\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits.length, 2);
});

test("parse append / prepend", () => {
	const r = parsePatch("file: f.ts\nappend:\n+z\n\nprepend:\n+w\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.patch.edits[0].op, "append");
		assert.equal(r.patch.edits[1].op, "prepend");
	}
});

test("multiple mixed operations", () => {
	const r = parsePatch("file: f.ts\n\nreplace 1#A:\n+x\n\ndelete 3#C\n\ninsert_after 5#E:\n+y\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits.length, 3);
});

test("body kept literally (with + prefix, markdown)", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A:\n++i\n+- item\n+\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		const e = r.patch.edits[0];
		if (e.op === "replace") assert.deepEqual(e.body, ["+i", "- item", ""]);
	}
});

test("colon is optional", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A\n+x\n");
	assert.equal(r.ok, true);
});

test("CRLF normalization", () => {
	const r = parsePatch("file: f.ts\r\nreplace 1#A:\r\n+x\r\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		const e = r.patch.edits[0];
		if (e.op === "replace") assert.deepEqual(e.body, ["x"]); // no \r
	}
});

// --- error paths ---

test("missing file header errors", () => {
	const r = parsePatch("replace 1#A:\n+x\n");
	assert.equal(r.ok, false);
});

test("empty input errors", () => {
	assert.equal(parsePatch("").ok, false);
	assert.equal(parsePatch("\n\n").ok, false);
});

test("empty body errors", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A:\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "parse");
});

test("unknown verb errors (rejects SWAP/DEL)", () => {
	const r = parsePatch("file: f.ts\nSWAP 1#A:\n+x\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "parse");
});

test("stray body errors", () => {
	const r = parsePatch("file: f.ts\n+x\n");
	assert.equal(r.ok, false);
});

test("delete with body errors", () => {
	const r = parsePatch("file: f.ts\ndelete 2#X\n+leak\n");
	// a + line right after delete → the next round treats it as a stray body
	assert.equal(r.ok, false);
});

test("error includes the input line number", () => {
	const r = parsePatch("file: f.ts\n\nreplace 1#A:\n+x\n\nSWAP 2#B:\n+y\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.ok(r.error.line && r.error.line >= 5);
});

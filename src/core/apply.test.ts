import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash } from "./hash.ts";
import { splitLines } from "./lines.ts";
import { applyEdits } from "./apply.ts";
import type { Anchor } from "./types.ts";

/** Live anchor: hash the current content at the given line (1-based). */
function at(text: string, line: number): Anchor {
	return { line, hash: computeLineHash(line, splitLines(text)[line - 1]) };
}

// --- happy paths ---

test("replace single line", () => {
	const text = "a\nb\nc\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 2), body: ["B"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nB\nc\n");
});

test("replace range", () => {
	const text = "a\nb\nc\nd\ne\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 2), end: at(text, 4), body: ["X", "Y"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nX\nY\ne\n");
});

test("delete single line / range", () => {
	const text = "a\nb\nc\nd\n";
	const r = applyEdits(text, [{ op: "delete", start: at(text, 2), end: at(text, 3) }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nd\n");
});

test("insert_after", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "insert_after", anchor: at(text, 1), body: ["x"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("insert_before", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "insert_before", anchor: at(text, 2), body: ["x"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("append / prepend", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [
		{ op: "prepend", body: ["head"] },
		{ op: "append", body: ["tail"] },
	]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "head\na\nb\ntail\n");
});

test("multiple out-of-order ops → applied at the right positions", () => {
	const text = "a\nb\nc\n";
	const r = applyEdits(text, [
		{ op: "insert_after", anchor: at(text, 3), body: ["z"] },
		{ op: "replace", start: at(text, 1), body: ["A"] },
	]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "A\nb\nc\nz\n");
});

test("touchedLines covers exactly the lines this edit produced (new-file indices)", () => {
	const text = "a\nb\nc\n";
	const r = applyEdits(text, [
		{ op: "insert_after", anchor: at(text, 3), body: ["z"] },
		{ op: "replace", start: at(text, 1), body: ["A"] },
	]);
	assert.equal(r.ok, true);
	if (r.ok) {
		// new file: [A, b, c, z]; this edit produced line index 0 (A) and 3 (z)
		assert.deepEqual([...r.touchedLines], [0, 3]);
	}
});

test("touchedLines for append", () => {
	const text = "a\n";
	const r = applyEdits(text, [{ op: "append", body: ["b", "c"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.deepEqual([...r.touchedLines], [1, 2]);
});

test("touchedLines for delete re-anchors the line that shifted into the gap", () => {
	const text = "a\nb\nc\nd\n";
	const r = applyEdits(text, [{ op: "delete", start: at(text, 2) }]);
	assert.equal(r.ok, true);
	if (r.ok) {
		// new file: [a, c, d]; deleting line 2 (b) shifts c into index 1
		assert.deepEqual([...r.touchedLines], [1]);
	}
});

// --- error paths ---

test("anchor hash mismatch rejected (line changed)", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "replace", start: { line: 1, hash: "WRONG" }, body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("line out of range rejected", () => {
	const text = "a\n";
	const r = applyEdits(text, [{ op: "replace", start: { line: 5, hash: computeLineHash(1, "a") }, body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("anchor mismatch when the cited line's content differs (live verification)", () => {
	// hash for line 2's content, but cited as line 1 → must fail because line 1's live content differs
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "replace", start: { line: 1, hash: computeLineHash(2, "b") }, body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("reverse-order range rejected", () => {
	const text = "a\nb\nc\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 3), end: at(text, 1), body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("overlapping edits rejected", () => {
	const text = "a\nb\nc\nd\n";
	const r = applyEdits(text, [
		{ op: "replace", start: at(text, 2), end: at(text, 3), body: ["x"] },
		{ op: "replace", start: at(text, 3), body: ["y"] },
	]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("conflict at the same insertion point rejected", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [
		{ op: "insert_after", anchor: at(text, 1), body: ["x"] },
		{ op: "insert_after", anchor: at(text, 1), body: ["y"] },
	]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("noop (byte-identical body) rejected", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["a"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "noop");
});

test("unrelated change elsewhere does NOT block the edit (no global stale check)", () => {
	// read-time text and current text differ at line 3, but we only touch line 1 — must succeed
	const readText = "a\nb\nc\n";
	const currentText = "a\nb\nCHANGED\n";
	const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 1), body: ["A"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "A\nb\nCHANGED\n");
});

test("CRLF line endings preserved", () => {
	const text = "a\r\nb\r\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["A"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "A\r\nb\r\n");
});


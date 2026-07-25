import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshot } from "./snapshot.ts";
import { applyEdits } from "./apply.ts";
import type { Edit, FileSnapshot } from "./types.ts";

const snap = (text: string): FileSnapshot => createSnapshot("f.ts", text);
const ln = (s: FileSnapshot, line: number) => ({ line, hash: s.lineHashes[line - 1] });

// --- happy paths ---

test("replace single line", () => {
	const text = "a\nb\nc\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: ln(s, 2), body: ["B"] }], s);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nB\nc\n");
});

test("replace range", () => {
	const text = "a\nb\nc\nd\ne\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[{ op: "replace", start: ln(s, 2), end: ln(s, 4), body: ["X", "Y"] }],
		s,
	);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nX\nY\ne\n");
});

test("delete single line / range", () => {
	const text = "a\nb\nc\nd\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "delete", start: ln(s, 2), end: ln(s, 3) }], s);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nd\n");
});

test("insert_after", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "insert_after", anchor: ln(s, 1), body: ["x"] }], s);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("insert_before", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "insert_before", anchor: ln(s, 2), body: ["x"] }], s);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("append / prepend", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[
			{ op: "prepend", body: ["head"] },
			{ op: "append", body: ["tail"] },
		],
		s,
	);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "head\na\nb\ntail\n");
});

test("multiple out-of-order ops → applied at the right positions", () => {
	const text = "a\nb\nc\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[
			{ op: "insert_after", anchor: ln(s, 3), body: ["z"] },
			{ op: "replace", start: ln(s, 1), body: ["A"] },
		],
		s,
	);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "A\nb\nc\nz\n");
});

test("result carries diff and newSnapshot", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: ln(s, 1), body: ["A"] }], s);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.ok(r.diff.includes("@@"));
		assert.equal(r.newSnapshot.text, "A\nb\n");
		assert.equal(r.newSnapshot.lineHashes.length, 2);
	}
});

test("closed loop: newSnapshot can be used for the next edit", () => {
	let s = snap("a\nb\n");
	let cur = s.text;
	const r1 = applyEdits(cur, [{ op: "replace", start: ln(s, 1), body: ["A"] }], s);
	assert.equal(r1.ok, true);
	if (r1.ok) {
		cur = r1.text;
		s = r1.newSnapshot;
		const r2 = applyEdits(cur, [{ op: "replace", start: ln(s, 2), body: ["B"] }], s);
		assert.equal(r2.ok, true);
		if (r2.ok) assert.equal(r2.text, "A\nB\n");
	}
});

// --- error paths ---

test("stale (file changed) rejected", () => {
	const s = snap("a\nb\n");
	const r = applyEdits("a\nCHANGED\n", [{ op: "replace", start: ln(s, 1), body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "stale");
});

test("anchor hash mismatch rejected (guards against misremembering)", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: { line: 1, hash: "WRONG" }, body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("line out of range rejected", () => {
	const text = "a\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: { line: 5, hash: s.lineHashes[0] }, body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("reverse-order range rejected", () => {
	const text = "a\nb\nc\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[{ op: "replace", start: ln(s, 3), end: ln(s, 1), body: ["x"] }],
		s,
	);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("overlapping edits rejected", () => {
	const text = "a\nb\nc\nd\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[
			{ op: "replace", start: ln(s, 2), end: ln(s, 3), body: ["x"] },
			{ op: "replace", start: ln(s, 3), body: ["y"] },
		],
		s,
	);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("conflict at the same insertion point rejected", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(
		text,
		[
			{ op: "insert_after", anchor: ln(s, 1), body: ["x"] },
			{ op: "insert_after", anchor: ln(s, 1), body: ["y"] },
		],
		s,
	);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "range");
});

test("noop (byte-identical body) rejected", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: ln(s, 1), body: ["a"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "noop");
});

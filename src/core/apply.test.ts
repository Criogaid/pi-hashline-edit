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
	if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("line out of range rejected", () => {
	const text = "a\n";
	const r = applyEdits(text, [{ op: "replace", start: { line: 5, hash: computeLineHash(1, "a") }, body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("anchor mismatch when the cited line's content differs (live verification)", () => {
	// hash for line 2's content, but cited as line 1 → must fail because line 1's live content differs
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "replace", start: { line: 1, hash: computeLineHash(2, "b") }, body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("reverse-order range rejected", () => {
	const text = "a\nb\nc\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 3), end: at(text, 1), body: ["x"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("overlapping edits rejected", () => {
	const text = "a\nb\nc\nd\n";
	const r = applyEdits(text, [
		{ op: "replace", start: at(text, 2), end: at(text, 3), body: ["x"] },
		{ op: "replace", start: at(text, 3), body: ["y"] },
	]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("conflict at the same insertion point rejected", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [
		{ op: "insert_after", anchor: at(text, 1), body: ["x"] },
		{ op: "insert_after", anchor: at(text, 1), body: ["y"] },
	]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("noop (byte-identical body) rejected", () => {
	const text = "a\nb\n";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["a"] }]);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.failure.kind, "noop");
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

// --- shifted-anchor recovery ---

test("shifted recovery: content moved down → found with a fresh anchor", () => {
	const readText = "a\nb\nc\nd\ne\n";
	const currentText = "a\nX\nb\nc\nd\ne\n"; // inserted X after line 1 → "c" moved 3→4
	const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 3), body: ["C"] }]);
	assert.equal(r.ok, false);
	if (!r.ok && r.failure.kind === "anchor") {
		const f = r.failure.failures[0];
		assert.equal(f.recovery.kind, "found");
		if (f.recovery.kind === "found") {
			assert.equal(f.recovery.newLine, 4);
			// the rescued anchor must verify against the current file
			assert.equal(computeLineHash(4, splitLines(currentText)[3]), f.recovery.newHash);
		}
	}
});

test("rescued anchor lets the retry succeed without a re-read", () => {
	const readText = "a\nb\nc\nd\ne\n";
	const currentText = "a\nX\nb\nc\nd\ne\n";
	// first attempt with a stale anchor → rescued
	const r1 = applyEdits(currentText, [{ op: "replace", start: at(readText, 3), body: ["C"] }]);
	assert.equal(r1.ok, false);
	if (r1.ok) return;
	if (r1.failure.kind !== "anchor") return;
	const f = r1.failure.failures[0];
	assert.equal(f.recovery.kind, "found");
	if (f.recovery.kind !== "found") return;
	// retry with the rescued anchor → succeeds, file unchanged elsewhere
	const r2 = applyEdits(currentText, [
		{ op: "replace", start: { line: f.recovery.newLine, hash: f.recovery.newHash }, body: ["C"] },
	]);
	assert.equal(r2.ok, true);
	if (r2.ok) assert.equal(r2.text, "a\nX\nb\nC\nd\ne\n");
});

test("shifted recovery: duplicate content → ambiguous candidates", () => {
	const readText = "a\nx\nb\nx\nc\n";
	const currentText = "a\nY\nx\nb\nx\nc\n"; // both "x" shifted
	const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 2), body: ["Z"] }]);
	assert.equal(r.ok, false);
	if (!r.ok && r.failure.kind === "anchor") {
		const f = r.failure.failures[0];
		assert.equal(f.recovery.kind, "ambiguous");
		if (f.recovery.kind === "ambiguous") {
			assert.deepEqual(
				f.recovery.candidates.map((c) => c.line),
				[3, 5],
			);
		}
	}
});

test("shifted recovery: content genuinely changed → none, with live content", () => {
	const readText = "a\nb\nc\n";
	const currentText = "a\nBCHANGED\nc\n"; // "b" is gone
	const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 2), body: ["B"] }]);
	assert.equal(r.ok, false);
	if (!r.ok && r.failure.kind === "anchor") {
		const f = r.failure.failures[0];
		assert.equal(f.recovery.kind, "none");
		assert.equal(f.current?.content, "BCHANGED");
	}
});

test("collect-all: two stale anchors in one batch → both failures returned", () => {
	const readText = "a\nb\nc\nd\n";
	const currentText = "X\na\nb\nc\nd\n"; // inserted X at top → all shifted +1
	const r = applyEdits(currentText, [
		{ op: "replace", start: at(readText, 2), body: ["B"] },
		{ op: "replace", start: at(readText, 4), body: ["D"] },
	]);
	assert.equal(r.ok, false);
	if (!r.ok && r.failure.kind === "anchor") {
		assert.equal(r.failure.failures.length, 2);
		const found = r.failure.failures.map((f) => (f.recovery.kind === "found" ? f.recovery.newLine : -1));
		assert.deepEqual(found, [3, 5]);
	}
});

test("shiftRadius=0 disables rescue (always none)", () => {
	const readText = "a\nb\nc\nd\ne\n";
	const currentText = "a\nX\nb\nc\nd\ne\n";
	const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 3), body: ["C"] }], 4, 0);
	assert.equal(r.ok, false);
	if (!r.ok && r.failure.kind === "anchor") {
		assert.equal(r.failure.failures[0].recovery.kind, "none");
	}
});


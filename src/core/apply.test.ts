import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash } from "./hash.ts";
import { splitLines } from "./lines.ts";
import { applyEdits } from "./apply.ts";
import type { Anchor, Edit } from "./types.ts";

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

test("editing another line preserves standalone carriage returns at EOF", () => {
	for (const ending of ["\n", "\r\n"]) {
		const text = `first${ending}last\r`;
		const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["changed"] }]);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.text, `changed${ending}last\r`);
	}
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

test("byte-identical edits succeed without updated anchors after validation", () => {
	for (const text of ["a\nb\n", "\uFEFFa\r\nb\n"]) {
		const body = text.startsWith("\uFEFF") ? "\uFEFFa" : "a";
		const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: [body] }]);
		assert.deepEqual(r, { ok: true, text, changed: false, touchedLines: [], contextLines: [] });
		const invalid = applyEdits(text, [{ op: "replace", start: at("wrong\nb\n", 1), body: [body] }]);
		assert.ok(!invalid.ok && invalid.failure.kind === "anchor");
	}
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

test("editing a mixed-ending file preserves untouched separators", () => {
	const before = "first\r\nsecond\nthird\r\n";
	const result = applyEdits(before, [{ op: "replace", start: at(before, 2), body: ["SECOND"] }]);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.text, "first\r\nSECOND\nthird\r\n");
});

test("inserting and deleting in mixed-ending files preserves surviving separators", () => {
	const before = "a\r\nb\nc\r\nlast";
	const inserted = applyEdits(before, [{ op: "insert_after", anchor: at(before, 2), body: ["x"] }]);
	assert.equal(inserted.ok, true);
	if (inserted.ok) assert.equal(inserted.text, "a\r\nb\nx\r\nc\r\nlast");
	const deleted = applyEdits(before, [{ op: "delete", start: at(before, 2) }]);
	assert.equal(deleted.ok, true);
	if (deleted.ok) assert.equal(deleted.text, "a\r\nc\r\nlast");
});

test("replacing one line with several keeps the block's trailing gap", () => {
	const before = "a\r\nb\nc\r\nd";
	const result = applyEdits(before, [{ op: "replace", start: at(before, 2), body: ["X", "Y", "Z"] }]);
	assert.equal(result.ok, true);
	// b's gap (\n) moves to the last new line, so the boundary to c is unchanged;
	// b has no internal gap; both new internal gaps use the file style, like replace("b", "X\nY\nZ").
	if (result.ok) assert.equal(result.text, "a\r\nX\r\nY\r\nZ\nc\r\nd");
});

test("a file without a final newline keeps not having one", () => {
	const text = "a\nb";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 2), body: ["B"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nB");
});

test("CRLF without a final newline keeps not having one", () => {
	const text = "a\r\nb";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["A"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "A\r\nb");
});

test("appending to a file without a final newline keeps it absent", () => {
	const text = "a";
	const r = applyEdits(text, [{ op: "append", body: ["b"] }]);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.text, "a\nb");
});

test("noop is still detected when the file lacks a final newline", () => {
	const text = "a\nb";
	const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["a"] }]);
	assert.deepEqual(r, { ok: true, text, changed: false, touchedLines: [], contextLines: [] });
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
			assert.equal(f.recovery.scope, "local");
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
			assert.equal(f.recovery.scope, "local");
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

test("full-file recovery finds distant content and anchors beyond the current EOF", () => {
	for (const [oldLine, newLine] of [[2, 90], [90, 2], [190, 2]]) {
		const lines = Array.from({ length: 100 }, () => "filler");
		lines[newLine - 1] = "target";
		const result = applyEdits(lines.join("\n"), [
			{ op: "delete", start: { line: oldLine, hash: computeLineHash(oldLine, "target") } },
		]);
		assert.ok(!result.ok && result.failure.kind === "anchor");
		assert.deepEqual(result.failure.failures[0].recovery, {
			kind: "found", scope: "full-file", newLine, newHash: computeLineHash(newLine, "target"),
		});
	}
});

test("full-file recovery collects both sides while preserving local candidate priority", () => {
	for (const { positions, selected, scope } of [
		{ positions: [3, 95], selected: [3, 95], scope: "full-file" },
		{ positions: [3, 49, 95], selected: [49], scope: "local" },
		{ positions: [3, 49, 51, 95], selected: [49, 51], scope: "local" },
	]) {
		const lines = Array.from({ length: 100 }, () => "filler");
		for (const line of positions) lines[line - 1] = "target";
		const result = applyEdits(lines.join("\n"), [
			{ op: "delete", start: { line: 50, hash: computeLineHash(50, "target") } },
		]);
		assert.ok(!result.ok && result.failure.kind === "anchor");
		assert.deepEqual(result.failure.failures[0].recovery, selected.length === 1
			? { kind: "found", scope, newLine: selected[0], newHash: computeLineHash(selected[0], "target") }
			: { kind: "ambiguous", scope, candidates: selected.map(line => ({ line, hash: computeLineHash(line, "target") })) });
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


test("rejects CR or LF embedded in body elements", () => {
	for (const body of [["x\ny"], ["x\ry"]]) {
		const result = applyEdits("a\n", [{ op: "append", body }]);
		assert.deepEqual(result, {
			ok: false,
			failure: { kind: "input", message: "INVALID_BODY: each body element must contain exactly one logical line.", checks: [] },
		});
	}
});

test("BOM stays at byte zero through first-line edits while anchors retain their original hashes", () => {
	for (const text of ["\uFEFFfirst\nsecond\n", "\uFEFFfirst\r\nsecond\r\n", "\uFEFFfirst\r\nsecond\n", "\uFEFFfirst\nsecond"]) {
		const ending = text.includes("\r\n") ? "\r\n" : "\n";
		const rest = text.slice(text.indexOf("\n") + 1);
		const cases: [Edit, string][] = [
			[{ op: "replace", start: at(text, 1), body: ["changed"] }, `\uFEFFchanged${ending}${rest}`],
			[{ op: "replace", start: at(text, 1), body: ["\uFEFFchanged"] }, `\uFEFFchanged${ending}${rest}`],
			[{ op: "delete", start: at(text, 1) }, `\uFEFF${rest}`],
			[{ op: "prepend", body: ["new"] }, `\uFEFFnew${ending}${text.slice(1)}`],
			[{ op: "insert_before", anchor: at(text, 1), body: ["new"] }, `\uFEFFnew${ending}${text.slice(1)}`],
			[{ op: "delete", start: at(text, 1), end: at(text, 2) }, "\uFEFF"],
		];
		for (const [edit, expected] of cases) {
			const result = applyEdits(text, [edit]);
			assert.ok(result.ok);
			assert.equal(result.text, expected, `${edit.op}: ${JSON.stringify(text)}`);
		}
	}
	for (const text of ["\uFEFF", "\uFEFFfirst"]) {
		const result = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["changed"] }]);
		assert.ok(result.ok);
		assert.equal(result.text, "\uFEFFchanged");
	}
	const embedded = "\uFEFFfirst\ninside\uFEFFcontent\n";
	const result = applyEdits(embedded, [{ op: "replace", start: at(embedded, 1), body: ["changed"] }]);
	assert.ok(result.ok);
	assert.equal(result.text, "\uFEFFchanged\ninside\uFEFFcontent\n");
});

test("failed batches report every supplied anchor in input order from one snapshot", () => {
	const text = "a\nb\nc\nd\ne\nf\n";
	const stale = { line: 2, hash: "ZZ" };
	const edits: Edit[] = [
		{ op: "replace", start: at(text, 1), end: stale, body: ["A"] },
		{ op: "delete", start: stale, end: at(text, 4) },
		{ op: "insert_after", anchor: at(text, 5), body: ["E"] },
		{ op: "insert_before", anchor: stale, body: ["B"] },
		{ op: "append", body: ["last"] },
		{ op: "prepend", body: ["first"] },
	];
	const result = applyEdits(text, edits);
	assert.ok(!result.ok && result.failure.kind === "anchor");
	assert.deepEqual(result.failure.checks, [
		{ opIndex: 0, op: "replace", which: "anchor", cited: at(text, 1), status: "matched" },
		{ opIndex: 0, op: "replace", which: "end", cited: stale, status: "mismatched" },
		{ opIndex: 1, op: "delete", which: "anchor", cited: stale, status: "mismatched" },
		{ opIndex: 1, op: "delete", which: "end", cited: at(text, 4), status: "matched" },
		{ opIndex: 2, op: "insert_after", which: "anchor", cited: at(text, 5), status: "matched" },
		{ opIndex: 3, op: "insert_before", which: "anchor", cited: stale, status: "mismatched" },
	]);
	const invalid = applyEdits(text, [...edits, { op: "append", body: ["bad\nline"] }]);
	assert.ok(!invalid.ok && invalid.failure.kind === "input");
	assert.deepEqual(invalid.failure.checks, result.failure.checks.map((check) => ({ ...check, status: "not_checked" })));
});

test("matched anchor checks do not imply valid ranges", () => {
	const text = "a\nb\nc\n";
	const cases: { edits: Edit[]; kind: "range"; checks: number }[] = [
		{ edits: [{ op: "delete", start: at(text, 3), end: at(text, 1) }], kind: "range", checks: 2 },
		{ edits: [{ op: "replace", start: at(text, 1), end: at(text, 3), body: ["x"] }, { op: "delete", start: at(text, 2) }], kind: "range", checks: 3 },
	];
	for (const { edits, kind, checks } of cases) {
		const result = applyEdits(text, edits);
		assert.ok(!result.ok);
		assert.equal(result.failure.kind, kind);
		assert.equal(result.failure.checks.length, checks);
		assert.ok(result.failure.checks.every((check) => check.status === "matched"));
	}
});

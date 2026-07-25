import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshot } from "./snapshot.ts";
import { applyEdits } from "./apply.ts";
import type { Edit, FileSnapshot } from "./types.ts";

const snap = (text: string): FileSnapshot => createSnapshot("f.ts", text);
const ln = (s: FileSnapshot, line: number) => ({ line, hash: s.lineHashes[line - 1] });

// —— 正常路径 ——

test("replace 单行", () => {
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

test("delete 单行 / range", () => {
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

test("多操作乱序 → 按位置正确应用", () => {
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

test("结果带 diff 与 newSnapshot", () => {
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

test("闭环：newSnapshot 可用于下一次 edit", () => {
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

// —— 错误路径 ——

test("stale（文件已变）拒绝", () => {
	const s = snap("a\nb\n");
	const r = applyEdits("a\nCHANGED\n", [{ op: "replace", start: ln(s, 1), body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "stale");
});

test("anchor hash 不匹配拒绝（防记错）", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: { line: 1, hash: "WRONG" }, body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("行号越界拒绝", () => {
	const text = "a\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: { line: 5, hash: s.lineHashes[0] }, body: ["x"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "anchor");
});

test("range 逆序拒绝", () => {
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

test("重叠编辑拒绝", () => {
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

test("同插入点冲突拒绝", () => {
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

test("noop（body 字节相同）拒绝", () => {
	const text = "a\nb\n";
	const s = snap(text);
	const r = applyEdits(text, [{ op: "replace", start: ln(s, 1), body: ["a"] }], s);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "noop");
});

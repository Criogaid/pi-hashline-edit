import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch } from "./parse.ts";

test("解析 replace 单行", () => {
	const r = parsePatch("file: f.ts\n\nreplace 4#ABCD:\n+new line\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.patch.path, "f.ts");
		assert.equal(r.patch.edits.length, 1);
		assert.equal(r.patch.edits[0].op, "replace");
	}
});

test("解析 replace range", () => {
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

test("解析 delete（无 body）", () => {
	const r = parsePatch("file: f.ts\ndelete 2#XYZ\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits[0].op, "delete");
});

test("解析 insert_after / insert_before", () => {
	const r = parsePatch("file: f.ts\ninsert_after 3#ABC:\n+x\n\ninsert_before 5#DEF:\n+y\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits.length, 2);
});

test("解析 append / prepend", () => {
	const r = parsePatch("file: f.ts\nappend:\n+z\n\nprepend:\n+w\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.patch.edits[0].op, "append");
		assert.equal(r.patch.edits[1].op, "prepend");
	}
});

test("多操作混合", () => {
	const r = parsePatch("file: f.ts\n\nreplace 1#A:\n+x\n\ndelete 3#C\n\ninsert_after 5#E:\n+y\n");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.patch.edits.length, 3);
});

test("body 保留字面（含 + 前缀、markdown）", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A:\n++i\n+- item\n+\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		const e = r.patch.edits[0];
		if (e.op === "replace") assert.deepEqual(e.body, ["+i", "- item", ""]);
	}
});

test("冒号可选", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A\n+x\n");
	assert.equal(r.ok, true);
});

test("CRLF 归一", () => {
	const r = parsePatch("file: f.ts\r\nreplace 1#A:\r\n+x\r\n");
	assert.equal(r.ok, true);
	if (r.ok) {
		const e = r.patch.edits[0];
		if (e.op === "replace") assert.deepEqual(e.body, ["x"]); // 无 \r
	}
});

// —— 错误路径 ——

test("缺 file 头报错", () => {
	const r = parsePatch("replace 1#A:\n+x\n");
	assert.equal(r.ok, false);
});

test("空输入报错", () => {
	assert.equal(parsePatch("").ok, false);
	assert.equal(parsePatch("\n\n").ok, false);
});

test("空 body 报错", () => {
	const r = parsePatch("file: f.ts\nreplace 1#A:\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "parse");
});

test("未知 verb 报错（拒绝 SWAP/DEL）", () => {
	const r = parsePatch("file: f.ts\nSWAP 1#A:\n+x\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.kind, "parse");
});

test("stray body 报错", () => {
	const r = parsePatch("file: f.ts\n+x\n");
	assert.equal(r.ok, false);
});

test("delete 带 body 报错", () => {
	const r = parsePatch("file: f.ts\ndelete 2#X\n+leak\n");
	// delete 后紧跟 + 行 → 下一轮判为 stray body
	assert.equal(r.ok, false);
});

test("错误含输入行号", () => {
	const r = parsePatch("file: f.ts\n\nreplace 1#A:\n+x\n\nSWAP 2#B:\n+y\n");
	assert.equal(r.ok, false);
	if (!r.ok) assert.ok(r.error.line && r.error.line >= 5);
});

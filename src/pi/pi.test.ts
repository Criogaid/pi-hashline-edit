import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "./read-tool.ts";
import { missingInputError } from "./edit-tool.ts";

test("canonicalPath resolve 相对/绝对", () => {
	assert.equal(canonicalPath("/cwd", "foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "./foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "/abs/x.ts"), "/abs/x.ts");
});

test("missingInputError: edits 数组 → 明确告知不降级", () => {
	const msg = missingInputError("f.ts", { edits: [{ oldText: "a", newText: "b" }] });
	assert.ok(msg.includes("legacy"), msg);
	assert.ok(msg.includes("ONLY"), msg);
	assert.ok(msg.includes("f.ts"), msg);
});

test("missingInputError: 顶层 oldText/newText 也识别为旧格式", () => {
	const msg = missingInputError("f.ts", { oldText: "a", newText: "b" });
	assert.ok(msg.includes("legacy"));
});

test("missingInputError: 仅缺 input（非旧格式）", () => {
	const msg = missingInputError("f.ts", {});
	assert.ok(msg.includes("missing"));
	assert.ok(!msg.includes("legacy"));
});

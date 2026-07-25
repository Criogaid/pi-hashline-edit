import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "./read-tool.ts";
import { missingInputError } from "./edit-tool.ts";

test("canonicalPath resolves relative/absolute", () => {
	assert.equal(canonicalPath("/cwd", "foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "./foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "/abs/x.ts"), "/abs/x.ts");
});

test("missingInputError: edits array → explicit no-degradation message", () => {
	const msg = missingInputError("f.ts", { edits: [{ oldText: "a", newText: "b" }] });
	assert.ok(msg.includes("legacy"), msg);
	assert.ok(msg.includes("ONLY"), msg);
	assert.ok(msg.includes("f.ts"), msg);
});

test("missingInputError: top-level oldText/newText also recognized as legacy", () => {
	const msg = missingInputError("f.ts", { oldText: "a", newText: "b" });
	assert.ok(msg.includes("legacy"));
});

test("missingInputError: only input missing (not legacy)", () => {
	const msg = missingInputError("f.ts", {});
	assert.ok(msg.includes("missing"));
	assert.ok(!msg.includes("legacy"));
});

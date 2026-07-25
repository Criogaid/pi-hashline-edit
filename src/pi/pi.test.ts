import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "./read-tool.ts";

test("canonicalPath resolves relative and absolute", () => {
	assert.equal(canonicalPath("/cwd", "foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "./foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "/abs/x.ts"), "/abs/x.ts");
});

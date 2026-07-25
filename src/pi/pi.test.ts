import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "./read-tool.ts";
import { homedir } from "node:os";

test("canonicalPath resolves relative and absolute", () => {
	assert.equal(canonicalPath("/cwd", "foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "./foo.ts"), "/cwd/foo.ts");
	assert.equal(canonicalPath("/cwd", "/abs/x.ts"), "/abs/x.ts");
});

test("canonicalPath expands ~ to home directory", () => {
	const home = homedir();
	assert.equal(canonicalPath("/cwd", "~"), home);
	assert.equal(canonicalPath("/cwd", "~/foo.ts"), `${home}/foo.ts`);
});

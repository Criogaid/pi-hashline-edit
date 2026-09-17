import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "./read-tool.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

test("canonicalPath resolves relative and absolute", () => {
	const cwd = resolve("/cwd");
	const absolute = resolve("/abs/x.ts");
	assert.equal(canonicalPath(cwd, "foo.ts"), join(cwd, "foo.ts"));
	assert.equal(canonicalPath(cwd, "./foo.ts"), join(cwd, "foo.ts"));
	assert.equal(canonicalPath(cwd, absolute), absolute);
});

test("canonicalPath expands ~ to home directory", () => {
	const home = homedir();
	assert.equal(canonicalPath("/cwd", "~"), home);
	assert.equal(canonicalPath("/cwd", "~/foo.ts"), join(home, "foo.ts"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { computeLineHash } from "../core/hash.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { canonicalPath } from "./path.ts";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

test("canonicalPath matches Pi's file URL, @ prefix, and Unicode space handling", () => {
	const cwd = resolve("/cwd");
	const target = join(cwd, "space name.txt");
	const fileUrl = pathToFileURL(target).href;
	for (const input of ["space name.txt", "space\u00a0name.txt", "space\u2009name.txt", "@space name.txt", fileUrl, `@${fileUrl}`]) {
		assert.equal(canonicalPath(cwd, input), target, input);
	}
	assert.throws(() => canonicalPath(cwd, "file:///bad%ZZ"));
});

test("canonicalPath follows Pi's Windows shell-path conventions", () => {
	const cwd = resolve("/cwd");
	if (process.platform === "win32") {
		const target = "C:\\src\\file.txt";
		for (const input of ["/c/src/file.txt", "/mnt/c/src/file.txt", "/cygdrive/c/src/file.txt", "@/c/src/file.txt"]) {
			assert.equal(canonicalPath(cwd, input), target, input);
		}
		assert.equal(canonicalPath(cwd, "~\\file.txt"), join(homedir(), "file.txt"));
		assert.equal(canonicalPath(cwd, "@~\\file.txt"), join(homedir(), "file.txt"));
	} else {
		assert.equal(canonicalPath(cwd, "/c/src/file.txt"), "/c/src/file.txt");
	}
});

test("file tools share Pi-style URL and @ path resolution", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-path-"));
	try {
		const file = join(dir, "target.txt");
		const url = pathToFileURL(file).href;
		const ctx = { cwd: dir };
		await makeWriteOverride(dir).execute("write", { path: `@${url}`, content: "before\n" }, undefined, undefined, ctx);
		const read = await makeReadOverride(dir).execute("read", { path: url }, undefined, undefined, ctx);
		if (read.content[0]?.type !== "text") throw new Error("Expected a text read result");
		assert.match(read.content[0].text, /before/);
		await makeReplaceTool(dir).execute("replace", { path: url, find: "before", replace: "after" }, undefined, undefined, ctx);
		await makeEditOverride(dir).execute("edit", { path: `@${url}`, edits: [
			{ op: "replace", anchor: `1#${computeLineHash(1, "after")}`, body: ["edited"] },
		] }, undefined, undefined, ctx);
		const matches = await makeGrepOverride(dir).execute("grep", { path: `@${url}`, pattern: "edited" }, undefined, undefined);
		assert.match(matches.content[0].text, /edited/);
		assert.equal(await readFile(file, "utf8"), "edited\n");
		let commands = 0;
		const fusion = createActionFusionExecutor(async () => { commands++; return "checked"; });
		const fused = await makeWriteOverride(dir, fusion).execute("fused", {
			path: `@${url}`, content: "edited\n", then_run: { command: "check" },
		}, undefined, undefined, ctx);
		assert.equal(fused.details.actionFusion.command, "succeeded");
		assert.equal(commands, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

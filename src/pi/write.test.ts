import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWriteOverride } from "./write-tool.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { fileRevision } from "./file-commit.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { getState } from "./state.ts";

const context = (cwd: string) => ({ cwd }) as any;

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-write-"));
	try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("write schema follows the shared actionFusion switch", () => {
	assert.equal((makeWriteOverride("/tmp") as any).parameters.properties.then_run, undefined);
	const fusion = createActionFusionExecutor();
	assert.ok((makeWriteOverride("/tmp", fusion) as any).parameters.properties.then_run);
});

test("write preserves native default create/overwrite behavior", async () => withTemp(async (dir) => {
	const write = makeWriteOverride(dir) as any;
	const target = join(dir, "file.txt");
	await write.execute("create", { path: "file.txt", content: "one\n" }, undefined, undefined, context(dir));
	assert.equal(await readFile(target, "utf8"), "one\n");
	await write.execute("overwrite", { path: "file.txt", content: "two\n" }, undefined, undefined, context(dir));
	assert.equal(await readFile(target, "utf8"), "two\n");
}));

test("write supports create-only, overwrite-only, and expectedRevision", async () => withTemp(async (dir) => {
	const write = makeWriteOverride(dir) as any;
	await write.execute("create", { path: "new.txt", content: "new\n", mode: "create" }, undefined, undefined, context(dir));
	await assert.rejects(write.execute("create-again", { path: "new.txt", content: "bad\n", mode: "create" }, undefined, undefined, context(dir)), /already exists/);
	await assert.rejects(write.execute("missing-overwrite", { path: "missing.txt", content: "bad\n", mode: "overwrite" }, undefined, undefined, context(dir)), /does not exist/);
	const revision = await fileRevision(join(dir, "new.txt"));
	await write.execute("revision", { path: "new.txt", content: "updated\n", expectedRevision: revision }, undefined, undefined, context(dir));
	await assert.rejects(write.execute("stale", { path: "new.txt", content: "bad\n", expectedRevision: revision }, undefined, undefined, context(dir)), /expectedRevision/);
	assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "updated\n");
}));

test("concurrent writes cannot both consume the same expectedRevision", async () => withTemp(async (dir) => {
	const target = join(dir, "concurrent.txt");
	await writeFile(target, "original\n");
	const expectedRevision = await fileRevision(target);
	const write = makeWriteOverride(dir);
	const results = await Promise.allSettled(["first\n", "second\n"].map((content) =>
		write.execute("concurrent", { path: target, content, expectedRevision }, undefined, undefined, context(dir)),
	));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected && rejected.status === "rejected");
	assert.match(rejected.reason.message, /expectedRevision/);
}));

test("write anchors chain into edit with a non-default hash length", async () => withTemp(async (dir) => {
	const state = getState();
	const previousConfig = state.config;
	try {
		state.config = { ...previousConfig, hashLen: 6 };
		const result = await makeWriteOverride(dir).execute("write", { path: "anchors.txt", content: "before\n" }, undefined, undefined, context(dir));
		const anchor = result.content[0].text.match(/1#([0-9A-Z]+)/);
		assert.ok(anchor);
		assert.equal(anchor[1].length, 6);
		assert.doesNotMatch(result.content[0].text, /before|│/);
		await makeEditOverride(dir).execute("edit", { path: "anchors.txt", edits: [{ op: "replace", anchor: anchor[0], body: ["after"] }] }, undefined, undefined, context(dir));
		assert.equal(await readFile(join(dir, "anchors.txt"), "utf8"), "after\n");
	} finally {
		state.config = previousConfig;
	}
}));

test("write returns at most 40 default anchors", async () => withTemp(async (dir) => {
	const content = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
	const result = await makeWriteOverride(dir).execute("write", { path: "large.txt", content }, undefined, undefined, context(dir));
	assert.equal(result.content[0].text.match(/\b\d+#[0-9A-Z]+\b/g)?.length, 40);
	assert.match(result.content[0].text, /… \(460 more/);
}));

test("write publishes anchors after an unchanged then_run", async () => withTemp(async (dir) => {
	const fusion = createActionFusionExecutor(async () => "checked");
	const write = makeWriteOverride(dir, fusion) as any;
	const result = await write.execute("unchanged", { path: "unchanged.txt", content: "mutation\n", then_run: { command: "check" } }, undefined, undefined, context(dir));
	const text = result.content.map((block: any) => block.text).join("\n");
	assert.match(text, /Revision:[\s\S]*Fresh anchors: 1#[0-9A-Z]+/);
	assert.match(text, /\[then_run:succeeded\]/);
	assert.equal(result.details.actionFusion.freshness, "unchanged");
}));

test("write omits pre-command anchors when then_run changes the target", async () => withTemp(async (dir) => {
	const target = join(dir, "changed.txt");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); return "checked"; });
	const write = makeWriteOverride(dir, fusion) as any;
	const result = await write.execute("changed", { path: "changed.txt", content: "mutation\n", then_run: { command: "check" } }, undefined, undefined, context(dir));
	const text = result.content.map((block: any) => block.text).join("\n");
	assert.match(text, /Mutation revision:/);
	assert.match(text, /Pre-command anchors are omitted/);
	assert.match(text, /mutation revision may not describe the final file/i);
	assert.doesNotMatch(text, /Fresh anchors:|\b1#[0-9A-Z]+\b/);
	assert.equal(result.details.actionFusion.freshness, "changed");
	assert.deepEqual(write.renderResult(result, { isPartial: false }, {}, { isError: false }).render(100), []);
}));

test("write omits anchors when then_run removes the target", async () => withTemp(async (dir) => {
	const target = join(dir, "missing.txt");
	const fusion = createActionFusionExecutor(async () => { await rm(target); return "removed"; });
	const result = await makeWriteOverride(dir, fusion).execute("missing", { path: "missing.txt", content: "mutation\n", then_run: { command: "remove" } }, undefined, undefined, context(dir));
	const text = result.content.map((block: any) => block.text).join("\n");
	assert.equal(result.details.actionFusion.freshness, "missing");
	assert.match(text, /Pre-command anchors are omitted/);
	assert.doesNotMatch(text, /Fresh anchors:/);
}));

test("write omits anchors when a failed then_run changed the target", async () => withTemp(async (dir) => {
	const target = join(dir, "failed.txt");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "changed before failure\n"); throw new Error("command failed"); });
	const result = await makeWriteOverride(dir, fusion).execute("failed", { path: "failed.txt", content: "mutation\n", then_run: { command: "fail" } }, undefined, undefined, context(dir));
	const text = result.content.map((block: any) => block.text).join("\n");
	assert.equal(result.details.actionFusion.freshness, "changed");
	assert.equal(result.details.actionFusion.command, "failed");
	assert.match(text, /Pre-command anchors are omitted/);
	assert.doesNotMatch(text, /Fresh anchors:/);
}));

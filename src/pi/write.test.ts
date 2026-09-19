import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWriteTool } from "./write-tool.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { fileRevision } from "./file-commit.ts";

const context = (cwd: string) => ({ cwd }) as any;

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-write-"));
	try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("write schema follows the shared actionFusion switch", () => {
	assert.equal((makeWriteTool("/tmp") as any).parameters.properties.then_run, undefined);
	const fusion = createActionFusionExecutor();
	assert.ok((makeWriteTool("/tmp", fusion) as any).parameters.properties.then_run);
});

test("write preserves native default create/overwrite behavior", async () => withTemp(async (dir) => {
	const write = makeWriteTool(dir) as any;
	const target = join(dir, "file.txt");
	await write.execute("create", { path: "file.txt", content: "one\n" }, undefined, undefined, context(dir));
	assert.equal(await readFile(target, "utf8"), "one\n");
	await write.execute("overwrite", { path: "file.txt", content: "two\n" }, undefined, undefined, context(dir));
	assert.equal(await readFile(target, "utf8"), "two\n");
}));

test("write supports create-only, overwrite-only, and expectedRevision", async () => withTemp(async (dir) => {
	const write = makeWriteTool(dir) as any;
	await write.execute("create", { path: "new.txt", content: "new\n", mode: "create" }, undefined, undefined, context(dir));
	await assert.rejects(write.execute("create-again", { path: "new.txt", content: "bad\n", mode: "create" }, undefined, undefined, context(dir)), /already exists/);
	await assert.rejects(write.execute("missing-overwrite", { path: "missing.txt", content: "bad\n", mode: "overwrite" }, undefined, undefined, context(dir)), /does not exist/);
	const revision = await fileRevision(join(dir, "new.txt"));
	await write.execute("revision", { path: "new.txt", content: "updated\n", expectedRevision: revision }, undefined, undefined, context(dir));
	await assert.rejects(write.execute("stale", { path: "new.txt", content: "bad\n", expectedRevision: revision }, undefined, undefined, context(dir)), /expectedRevision/);
	assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "updated\n");
}));

test("write shares Action Fusion and reports command-induced stale content", async () => withTemp(async (dir) => {
	const target = join(dir, "fused.txt");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); return "checked"; });
	const write = makeWriteTool(dir, fusion) as any;
	const result = await write.execute("fused", { path: "fused.txt", content: "mutation\n", then_run: { command: "check" } }, undefined, undefined, context(dir));
	const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
	assert.match(text, /\[then_run:stale\]/);
	assert.equal(result.details.actionFusion.freshness, "changed");

test("write renderer keeps Fusion output and stale marker visible", async () => withTemp(async (dir) => {
	const target = join(dir, "rendered.txt");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); return "checked"; });
	const write = makeWriteTool(dir, fusion) as any;
	const result = await write.execute("rendered", { path: "rendered.txt", content: "mutation\n", then_run: { command: "check" } }, undefined, undefined, context(dir));
	const rendered: any = write.renderResult(result, { isPartial: false }, { fg: (_key: string, value: string) => value });
	assert.match(rendered.text, /checked/);
	assert.match(rendered.text, /then_run:stale/);
}));
}));

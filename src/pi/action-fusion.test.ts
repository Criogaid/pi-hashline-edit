import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { createActionFusionExecutor, THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from "./action-fusion.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "hashline-action-fusion-"));
}

const ctx = (cwd: string) => ({ cwd }) as any;

test("actionFusion is opt-in in the tool schemas", () => {
	assert.equal((makeEditOverride("/tmp") as any).parameters.properties.then_run, undefined);
	assert.equal((makeReplaceTool("/tmp") as any).parameters.properties.then_run, undefined);
	const fusion = createActionFusionExecutor();
	assert.ok((makeEditOverride("/tmp", fusion) as any).parameters.properties.then_run);
	assert.ok((makeReplaceTool("/tmp", fusion) as any).parameters.properties.then_run);
});

test("edit and replace share one embedded executor and preserve mutation results", async () => {
	const dir = await tempDir();
	try {
		const calls: string[] = [];
		const fusion = createActionFusionExecutor(async (_id, input) => {
			calls.push(input.command);
			return "checked";
		});
		const edit = makeEditOverride(dir, fusion) as any;
		const replace = makeReplaceTool(dir, fusion) as any;
		await writeFile(join(dir, "edit.txt"), "before\n");
		await writeFile(join(dir, "replace.txt"), "before\n");
		const editResult = await edit.execute("edit-1", { path: "edit.txt", edits: [{ op: "append", body: ["after"] }], then_run: { command: "check edit" } }, undefined, undefined, ctx(dir));
		const replaceResult = await replace.execute("replace-1", { path: "replace.txt", find: "before", replace: "after", then_run: { command: "check replace" } }, undefined, undefined, ctx(dir));
		assert.match(editResult.content.at(-1).text, new RegExp(THEN_RUN_SUCCEEDED));
		assert.match(replaceResult.content.at(-1).text, new RegExp(THEN_RUN_SUCCEEDED));
		assert.deepEqual(calls, ["check edit", "check replace"]);
		assert.equal((await readFile(join(dir, "edit.txt"), "utf8")), "before\nafter\n");
		assert.equal((await readFile(join(dir, "replace.txt"), "utf8")), "after\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mutation failure skips the command and command failure does not roll back", async () => {
	const dir = await tempDir();
	try {
		let calls = 0;
		const commandFailure = "compiler: unexpected token\nCommand exited with code 7";
		const fusion = createActionFusionExecutor(async () => { calls++; throw new Error(commandFailure); });
		await assert.rejects(
			fusion({ toolName: "edit", toolCallId: "x", absolutePath: join(dir, "missing.txt"), thenRun: { command: "check" }, mutate: async () => { throw new Error("anchor mismatch: current 1#ABCD"); }, signal: undefined, ctx: ctx(dir) }),
			(error: Error) => error.message.includes(THEN_RUN_SKIPPED) && error.message.includes("anchor mismatch: current 1#ABCD"),
		);
		assert.equal(calls, 0);
		const target = join(dir, "changed.txt");
		await writeFile(target, "changed\n");
		await assert.rejects(
			fusion({ toolName: "replace", toolCallId: "y", absolutePath: target, thenRun: { command: "check" }, mutate: async () => ({ content: [{ type: "text", text: "mutation" }], details: { ok: true } }), signal: undefined, ctx: ctx(dir) }),
			(error: Error) => error.message.includes(THEN_RUN_FAILED) && error.message.includes("mutation completed") && error.message.includes(commandFailure),
		);
		assert.equal(await readFile(target, "utf8"), "changed\n");
		assert.equal(calls, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cancelled calls do not mutate or run the command", async () => {
	const dir = await tempDir();
	try {
		const controller = new AbortController();
		controller.abort();
		let mutated = false;
		let commanded = false;
		const fusion = createActionFusionExecutor(async () => { commanded = true; return ""; });
		await assert.rejects(fusion({ toolName: "edit", toolCallId: "x", absolutePath: join(dir, "cancelled.txt"), thenRun: { command: "check" }, mutate: async () => { mutated = true; return { content: [], details: undefined }; }, signal: controller.signal, ctx: ctx(dir) }));
		assert.equal(mutated, false);
		assert.equal(commanded, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("default runner executes a real local command", async () => {
	const dir = await tempDir();
	try {
		const target = join(dir, "real.txt");
		await writeFile(target, "before\n");
		const fusion = createActionFusionExecutor();
		const result = await fusion({
			toolName: "edit",
			toolCallId: "real",
			absolutePath: target,
			thenRun: { command: "node -e \"process.stdout.write('real runner')\"" },
			mutate: async () => { await writeFile(target, "after\n"); return { content: [{ type: "text", text: "mutated" }], details: { ok: true } }; },
			signal: undefined,
			ctx: { ...ctx(dir), sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as any,
		});
		const output = result.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n");
		assert.match(output, /real runner/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	});

test("marks anchors stale when then_run changes the target", async () => {
	const dir = await tempDir();
	try {
		const target = join(dir, "stale.txt");
		await writeFile(target, "before\n");
		const fusion = createActionFusionExecutor(async () => { await writeFile(target, "changed by command\n"); return "changed"; });
		const result = await fusion({
			toolName: "edit",
			toolCallId: "stale",
			absolutePath: target,
			thenRun: { command: "mutate target" },
			mutate: async () => { await writeFile(target, "after mutation\n"); return { content: [{ type: "text", text: "mutated" }], details: {} }; },
			signal: undefined,
			ctx: ctx(dir),
		});
		const output = result.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n");
		assert.match(output, /\[then_run:stale\]/);
		assert.equal((result.details as any)?.actionFusion?.freshness, "changed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	});

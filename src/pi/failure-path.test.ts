import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionFusionExecutor, ActionFusionError } from "./action-fusion.ts";
import { FileMutationError } from "./file-commit.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-failure-"));
	try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const context = (cwd: string) => ({ cwd }) as any;
const result = () => ({ content: [{ type: "text" as const, text: "mutation" }], details: { publication: "PUBLISHED" } });

test("published post-processing failure skips command and preserves publication state", async () => withTemp(async (dir) => {
	const target = join(dir, "published.txt");
	await writeFile(target, "content\n");
	let commanded = false;
	const fusion = createActionFusionExecutor(async () => { commanded = true; return "never"; });
	await assert.rejects(
		fusion({ toolName: "edit", toolCallId: "published", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { throw new FileMutationError("post_process", "PUBLISHED", "file was published but result generation failed"); }, signal: undefined, ctx: context(dir) }),
		(error: unknown) => error instanceof ActionFusionError && error.publication === "PUBLISHED" && error.command === "skipped" && !commanded,
	);
}));

test("command failure still reports final changed freshness", async () => withTemp(async (dir) => {
	const target = join(dir, "failed.txt");
	await writeFile(target, "before\n");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); throw new Error("command failed"); });
	await assert.rejects(
		fusion({ toolName: "edit", toolCallId: "failed", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { await writeFile(target, "mutation\n"); return result(); }, signal: undefined, ctx: context(dir) }),
		(error: unknown) => error instanceof ActionFusionError && error.command === "failed" && error.freshness === "changed" && error.publication === "PUBLISHED",
	);
}));

test("timeout and cancellation do not rerun mutation and still inspect freshness", async () => withTemp(async (dir) => {
	const target = join(dir, "cancelled.txt");
	await writeFile(target, "before\n");
	let mutations = 0;
	const controller = new AbortController();
	const fusion = createActionFusionExecutor(async () => { controller.abort(); throw new Error("timed out"); });
	await assert.rejects(
		fusion({ toolName: "edit", toolCallId: "cancelled", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { mutations++; await writeFile(target, "mutation\n"); return result(); }, signal: controller.signal, ctx: context(dir) }),
		(error: unknown) => error instanceof ActionFusionError && error.command === "cancelled" && ["unchanged", "changed", "unknown"].includes(error.freshness),
	);
	assert.equal(mutations, 1);
}));

test("queue is released after a failed command", async () => withTemp(async (dir) => {
	const target = join(dir, "queue.txt");
	await writeFile(target, "before\n");
	let calls = 0;
	const fusion = createActionFusionExecutor(async () => { calls++; if (calls === 1) throw new Error("first command failed"); return "ok"; });
	const first = fusion({ toolName: "edit", toolCallId: "first", absolutePath: target, thenRun: { command: "fail" }, mutate: async () => { await writeFile(target, "first\n"); return result(); }, signal: undefined, ctx: context(dir) });
	await assert.rejects(first);
	const second = await fusion({ toolName: "edit", toolCallId: "second", absolutePath: target, thenRun: { command: "ok" }, mutate: async () => { await writeFile(target, "second\n"); return result(); }, signal: undefined, ctx: context(dir) });
	assert.equal(calls, 2);
	assert.match(second.content[1].type === "text" ? second.content[1].text : "", /then_run:succeeded/);
}));

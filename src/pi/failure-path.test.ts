import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionFusionExecutor, ActionFusionError } from "./action-fusion.ts";
import { byteRevision, FileMutationError } from "./file-commit.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-failure-"));
	try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const context = (cwd: string) => ({ cwd }) as any;
const result = (content: string) => ({ content: [{ type: "text" as const, text: "mutation" }], details: { publication: "PUBLISHED", publishedRevision: byteRevision(content) } });

test("published post-processing failure skips command and preserves publication state", async () => withTemp(async (dir) => {
	const target = join(dir, "published.txt");
	await writeFile(target, "content\n");
	let commanded = false;
	const updates: any[] = [];
	const fusion = createActionFusionExecutor(async () => { commanded = true; return "never"; });
	await assert.rejects(
		fusion({ toolCallId: "published", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { throw new FileMutationError("post_process", "PUBLISHED", "file was published but result generation failed"); }, signal: undefined, ctx: context(dir), onUpdate: (update) => updates.push(update) }),
		(error: unknown) => error instanceof ActionFusionError && error.publication === "PUBLISHED" && error.command === "skipped" && !commanded && /Re-read before retrying/.test(error.message),
	);
	assert.ok(updates.every((update) => update.details.actionFusion.mutationCompleted === false));
	assert.equal(updates.at(-1).details.actionFusion.publication, "PUBLISHED");
}));

test("command failure still reports final changed freshness", async () => withTemp(async (dir) => {
	const target = join(dir, "failed.txt");
	await writeFile(target, "before\n");
	const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); throw new Error("command failed"); });
	const outcome: any = await fusion({ toolCallId: "failed", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { await writeFile(target, "mutation\n"); return result("mutation\n"); }, signal: undefined, ctx: context(dir) });
	assert.deepEqual(outcome.details.actionFusion, { publication: "PUBLISHED", command: "failed", freshness: "changed" });
	assert.equal((outcome.content[1].text.match(/Re-read/g) ?? []).length, 1);
	assert.match(outcome.content[1].text, /then_run:stale/);
}));

test("timeout and cancellation do not rerun mutation and still inspect freshness", async () => withTemp(async (dir) => {
	const target = join(dir, "cancelled.txt");
	await writeFile(target, "before\n");
	let mutations = 0;
	const controller = new AbortController();
	const fusion = createActionFusionExecutor(async () => { controller.abort(); throw new Error("timed out"); });
	const outcome: any = await fusion({ toolCallId: "cancelled", absolutePath: target, thenRun: { command: "check" }, mutate: async () => { mutations++; await writeFile(target, "mutation\n"); return result("mutation\n"); }, signal: controller.signal, ctx: context(dir) });
	assert.equal(outcome.details.actionFusion.command, "cancelled");
	assert.equal(outcome.details.actionFusion.freshness, "unchanged");
	assert.equal(mutations, 1);
}));

test("queue is released after a failed command", async () => withTemp(async (dir) => {
	const target = join(dir, "queue.txt");
	await writeFile(target, "before\n");
	let calls = 0;
	const fusion = createActionFusionExecutor(async () => { calls++; if (calls === 1) throw new Error("first command failed"); return "ok"; });
	const first = fusion({ toolCallId: "first", absolutePath: target, thenRun: { command: "fail" }, mutate: async () => { await writeFile(target, "first\n"); return result("first\n"); }, signal: undefined, ctx: context(dir) });
	const failed: any = await first;
	assert.equal(failed.details.actionFusion.command, "failed");
	const second = await fusion({ toolCallId: "second", absolutePath: target, thenRun: { command: "ok" }, mutate: async () => { await writeFile(target, "second\n"); return result("second\n"); }, signal: undefined, ctx: context(dir) });
	assert.equal(calls, 2);
	assert.match(second.content[1].type === "text" ? second.content[1].text : "", /then_run:succeeded/);
}));

test("result generation failure cannot overwrite an already successful command", async () => withTemp(async (dir) => {
	const target = join(dir, "finalize.txt");
	const progress: any[] = [];
	const fusion = createActionFusionExecutor(async () => "command finished", (event) => progress.push(event));
	await assert.rejects(fusion({
		toolCallId: "finalize", absolutePath: target, thenRun: { command: "check" }, signal: undefined, ctx: context(dir),
		mutate: async () => { await writeFile(target, "saved\n"); return result("saved\n"); },
		finalizeMutation: () => { throw new Error("mutation result failure"); },
	}), /mutation result failure/);
	assert.equal(progress.filter((event) => event.command === "succeeded").length, 1);
	assert.equal(progress.at(-1).publication, "PUBLISHED");
	assert.equal(progress.at(-1).freshness, "unchanged");
	assert.equal(progress.at(-1).command, "succeeded");
	assert.equal(progress.at(-1).output, "command finished");
	assert.equal(progress.at(-1).reason, undefined);
}));

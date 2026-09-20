import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor, THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from "./action-fusion.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "hashline-action-fusion-"));
}

const ctx = (cwd: string) => ({ cwd }) as any;

test("actionFusion schemas and shared usage guidance are opt-in for every mutation tool", () => {
	const fusion = createActionFusionExecutor();
	for (const makeTool of [makeEditOverride, makeReplaceTool, makeWriteOverride]) {
		const disabled = makeTool("/tmp") as any;
		const enabled = makeTool("/tmp", fusion) as any;
		assert.equal(disabled.parameters.properties.then_run, undefined);
		assert.ok(enabled.parameters.properties.then_run);
		assert.deepEqual(enabled.promptGuidelines, [...(disabled.promptGuidelines ?? []), ...ACTION_FUSION_GUIDELINES]);
		assert.ok(!(disabled.promptGuidelines ?? []).some((line: string) => ACTION_FUSION_GUIDELINES.includes(line)));
	}
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
		assert.match(editResult.content.map((block: any) => block.text ?? "").join("\n"), /Updated anchors/);
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
			fusion({ toolCallId: "x", absolutePath: join(dir, "missing.txt"), thenRun: { command: "check" }, mutate: async () => { throw new Error("anchor mismatch: current 1#ABCD"); }, signal: undefined, ctx: ctx(dir) }),
			(error: Error) => error.message.includes(THEN_RUN_SKIPPED) && error.message.includes("anchor mismatch: current 1#ABCD"),
		);
		assert.equal(calls, 0);
		const target = join(dir, "changed.txt");
		await writeFile(target, "changed\n");
		const result = await fusion({ toolCallId: "y", absolutePath: target, thenRun: { command: "check" }, mutate: async () => ({ content: [{ type: "text", text: "mutation" }], details: { ok: true } }), signal: undefined, ctx: ctx(dir) });
		assert.equal(result.content[0].type === "text" && result.content[0].text, "mutation");
		const diagnostic = result.content[1].type === "text" ? result.content[1].text : "";
		assert.ok(diagnostic.includes(THEN_RUN_FAILED) && diagnostic.includes(commandFailure));
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
		await assert.rejects(fusion({ toolCallId: "x", absolutePath: join(dir, "cancelled.txt"), thenRun: { command: "check" }, mutate: async () => { mutated = true; return { content: [], details: undefined }; }, signal: controller.signal, ctx: ctx(dir) }));
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

test("Action Fusion omits structured anchors when target freshness is unknown", async () => {
	const dir = await tempDir();
	try {
		const missing = join(dir, "never-created.txt");
		let commands = 0;
		const fusion = createActionFusionExecutor(async () => { commands++; return "unexpected"; });
		const result = await fusion({
			toolCallId: "unknown",
			absolutePath: missing,
			thenRun: { command: "check" },
			mutate: async () => ({ content: [{ type: "text", text: "mutated" }], details: {} }),
			finalizeMutation: (mutation, publishAnchors) => ({
				...mutation,
				content: [{ type: "text", text: `mutated${publishAnchors ? " ANCHOR" : ""}` }],
			}),
			signal: undefined,
			ctx: ctx(dir),
		});
		const output = result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
		assert.equal(commands, 0);
		assert.equal((result.details as any).actionFusion.freshness, "unknown");
		assert.doesNotMatch(output, /ANCHOR/);
		assert.match(output, /Pre-command anchors are omitted/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit omits Updated anchors when then_run changes the target", async () => {
	const dir = await tempDir();
	try {
		const target = join(dir, "edit-stale.txt");
		await writeFile(target, "before\n");
		const fusion = createActionFusionExecutor(async () => { await writeFile(target, "command changed\n"); return "changed"; });
		const result = await makeEditOverride(dir, fusion).execute("edit-stale", {
			path: "edit-stale.txt",
			edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "before")}`, body: ["after"] }],
			then_run: { command: "change target" },
		}, undefined, undefined, ctx(dir));
		const output = result.content.map((block: any) => block.text ?? "").join("\n");
		assert.equal(result.details.actionFusion.freshness, "changed");
		assert.match(output, /Pre-command anchors are omitted/);
		assert.doesNotMatch(output, /Updated anchors|\b1#[0-9A-Z]+│/);
		assert.equal(await readFile(target, "utf8"), "command changed\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("all mutation tools forward command progress before completion in RPC mode", async () => {
	const dir = await tempDir();
	try {
		const events: ActionFusionProgress[] = [];
		const updates: any[] = [];
		const fusion = createActionFusionExecutor(async (_id, _input, _signal, _ctx, onUpdate) => {
			assert.equal(events.at(-1)?.command, "running");
			onUpdate?.({ content: [{ type: "text", text: "live output" }], details: undefined });
			assert.match(updates.at(-1).content.at(-1).text, /live output/);
			assert.equal(events.at(-1)?.output, "live output");
			return "final output";
		}, (event) => events.push(event));
		const cases = [
			{ tool: makeEditOverride(dir, fusion), input: { edits: [{ op: "append", body: ["after"] }] } },
			{ tool: makeReplaceTool(dir, fusion), input: { find: "before", replace: "after" } },
			{ tool: makeWriteOverride(dir, fusion), input: { content: "after\n" } },
		];
		for (const { tool, input } of cases) {
			events.length = 0;
			updates.length = 0;
			await writeFile(join(dir, "progress.txt"), "before\n");
			await tool.execute(tool.name, { path: "progress.txt", ...input, then_run: { command: "check" } }, undefined, (update: any) => updates.push(update), { cwd: dir, mode: "rpc" });
			assert.deepEqual(events.map((event) => event.command), ["waiting", "running", "running", "succeeded"]);
			assert.equal(events.at(-1)?.output, "final output");
			assert.equal(events.at(-1)?.publication, "PUBLISHED");
			assert.equal(updates.at(-1).details.actionFusion.command, "succeeded");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("progress reports skipped mutations and failed commands without rolling back", async () => {
	const dir = await tempDir();
	try {
		const events: ActionFusionProgress[] = [];
		let commands = 0;
		const fusion = createActionFusionExecutor(async () => { commands++; throw new Error("diagnostic\nCommand exited with code 7"); }, (event) => events.push(event));
		await assert.rejects(makeEditOverride(dir, fusion).execute("skip", { path: "missing.txt", edits: [{ op: "append", body: ["after"] }], then_run: { command: "check" } }, undefined, undefined, ctx(dir)));
		assert.equal(commands, 0);
		assert.deepEqual(events.map((event) => event.command), ["waiting", "skipped"]);
		events.length = 0;
		await writeFile(join(dir, "replace.txt"), "original\n");
		await assert.rejects(makeReplaceTool(dir, fusion).execute("replace-skip", { path: "replace.txt", find: "missing", replace: "changed", then_run: { command: "check" } }, undefined, undefined, ctx(dir)), /no matches/);
		assert.equal(commands, 0);
		assert.deepEqual(events.map((event) => event.command), ["waiting", "skipped"]);
		assert.equal(await readFile(join(dir, "replace.txt"), "utf8"), "original\n");
		events.length = 0;
		const failed = await makeWriteOverride(dir, fusion).execute("fail", { path: "failed.txt", content: "published\n", then_run: { command: "check" } }, undefined, undefined, ctx(dir));
		assert.equal(failed.details.actionFusion.command, "failed");
		assert.deepEqual(events.map((event) => event.command), ["waiting", "running", "failed"]);
		assert.match(events.at(-1)!.output, /diagnostic[\s\S]*code 7/);
		assert.equal(await readFile(join(dir, "failed.txt"), "utf8"), "published\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

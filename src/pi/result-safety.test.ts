import { computeLineHash } from "../core/hash.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { FileMutationError } from "./file-commit.ts";
import { finalizeMutationResult } from "./mutation-result.ts";

const text = (result: any) => result.content.map((block: any) => block.text ?? "").join("\n");

test("replace withholds anchors in progress and after commands change or remove the file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-result-"));
	try {
		for (const state of ["changed", "missing", "unknown"] as const) {
			for (const fails of [false, true]) {
				const path = join(dir, `${state}-${fails}.txt`);
				await writeFile(path, "before\n");
				const updates: any[] = [];
				const fusion = createActionFusionExecutor(async (_id, _input, _signal, _ctx, onUpdate) => {
					if (state === "changed") await writeFile(path, "command output\n");
					else {
						await rm(path);
						if (state === "unknown") await mkdir(path);
					}
					onUpdate?.({ content: [{ type: "text", text: "progress" }], details: undefined });
					if (fails) throw new Error("command failed");
					return "done";
				});
				const result = await makeReplaceTool(dir, fusion).execute("replace", {
					path, find: "before", replace: "after", then_run: { command: "check" },
				}, undefined, (update: any) => updates.push(update), { cwd: dir });
				assert.equal(result.details.actionFusion.freshness, state);
				assert.equal(result.details.publication, "PUBLISHED");
				assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
				assert.match(text(result), /Re-read/);
				for (const update of updates) assert.doesNotMatch(text(update), /Updated anchors|\d+#[0-9A-Z]+│/);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("progress callback failures preserve publication and do not prevent the command", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-progress-"));
	try {
		for (const callback of ["reporter", "update"]) {
			let commands = 0;
			const fail = () => { throw new Error("display unavailable"); };
			const fusion = createActionFusionExecutor(async () => { commands++; return "done"; }, callback === "reporter" ? fail : undefined);
			const path = join(dir, callback);
			const result = await makeWriteOverride(dir, fusion).execute("write", {
				path, content: "saved\n", then_run: { command: "check" },
			}, undefined, callback === "update" ? fail : undefined, { cwd: dir });
			assert.equal(commands, 1);
			assert.equal(await readFile(path, "utf8"), "saved\n");
			assert.equal(result.details.actionFusion.publication, "PUBLISHED");
			assert.equal(result.details.actionFusion.command, "succeeded");
			assert.match(text(result), /display unavailable/);
		}
		const fusion = createActionFusionExecutor(undefined, () => { throw new Error("display unavailable"); });
		await assert.rejects(fusion({
			toolCallId: "failed", absolutePath: join(dir, "failed"), thenRun: { command: "check" },
			mutate: async () => { throw new FileMutationError("post_process", "PUBLISHED", "original failure"); },
			signal: undefined, ctx: { cwd: dir } as any,
		}), (error: any) => error.publication === "PUBLISHED" && /original failure/.test(error.message));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("standalone and Fusion finalizers suppress anchors unless commit observations agree", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-finalizer-"));
	try {
		for (const observedRevision of ["published", "external", undefined]) {
			const mutation = { content: [{ type: "text" as const, text: "saved" }], details: { publication: "PUBLISHED" as const, publishedRevision: "published", observedRevision } };
			const finalize = (result: AgentToolResult<typeof mutation.details>, expose: boolean) => ({ ...result, content: [{ type: "text" as const, text: `saved${expose ? " ANCHOR" : ""}` }] });
			const standalone = finalizeMutationResult(mutation, finalize);
			const fused = await createActionFusionExecutor()({ toolCallId: "no-command", absolutePath: join(dir, "file"), thenRun: undefined, mutate: async () => mutation, finalizeMutation: finalize, signal: undefined, ctx: { cwd: dir } as any });
			for (const result of [standalone, fused]) {
				assert.equal(text(result).includes("ANCHOR"), observedRevision === "published");
				assert.equal(result.details.publication, "PUBLISHED");
				if (observedRevision !== "published") assert.match(text(result), /Re-read/);
			}
			assert.throws(() => finalizeMutationResult(mutation, () => { throw new Error("formatting failed"); }),
				(error: any) => error instanceof FileMutationError && error.publication === "PUBLISHED" && /publication=PUBLISHED/.test(error.message));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mutation anchor output and aggregate anchor diagnostics have byte budgets", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-budget-"));
	try {
		const path = join(dir, "long.txt");
		const long = "界".repeat(100000);
		for (const name of ["edit", "replace"]) {
			await writeFile(path, "before\n");
			const tool = name === "edit" ? makeEditOverride(dir) : makeReplaceTool(dir);
			const args = name === "edit" ? { edits: [{ op: "append", body: [long] }] } : { find: "before", replace: long };
			const result = await tool.execute(name, { path, ...args }, undefined, undefined, { cwd: dir });
			const output = text(result);
			assert.ok(Buffer.byteLength(output) < 17 * 1024);
			assert.match(output, /omitted|truncated/i);
			assert.doesNotMatch(output, /\d+#[0-9A-Z]+│界/);
			assert.ok((await readFile(path, "utf8")).includes(long));
		}
		await writeFile(path, "current\n");
		await assert.rejects(makeEditOverride(dir).execute("errors", {
			path, edits: Array.from({ length: 1000 }, () => ({ op: "delete", anchor: "1#XXXX" })),
		}, undefined, undefined, { cwd: dir }), (error: Error) => {
			assert.ok(Buffer.byteLength(error.message) <= 16 * 1024);
			assert.match(error.message, /omitted|truncated/i);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("every mutation entry rejects unpaired surrogates without running then_run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-unicode-"));
	try {
		let commands = 0;
		const fusion = createActionFusionExecutor(async () => { commands++; return "done"; });
		const path = join(dir, "file.txt");
		await writeFile(path, "original\n");
		for (const [tool, args] of [
			[makeEditOverride(dir, fusion), { edits: [{ op: "append", body: ["\ud800"] }] }],
			[makeReplaceTool(dir, fusion), { find: "original", replace: "\udfff" }],
			[makeWriteOverride(dir, fusion), { content: "\ud800" }],
		] as const) {
			await assert.rejects(tool.execute("unicode", { path, ...args, then_run: { command: "check" } }, undefined, undefined, { cwd: dir }),
				(error: any) => error.publication === "NOT_PUBLISHED" && /INVALID_UNICODE/.test(error.message));
			assert.equal(await readFile(path, "utf8"), "original\n");
		}
		assert.equal(commands, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ambiguous recovery bounds candidate lists and never claims content identity", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-candidates-"));
	try {
		const path = join(dir, "file.txt");
		const lines = Array.from({ length: 100 }, () => "same");
		lines[49] = "different";
		await writeFile(path, lines.join("\n"));
		await assert.rejects(makeEditOverride(dir).execute("ambiguous", {
			path, edits: Array.from({ length: 1000 }, () => ({ op: "delete", anchor: `50#${computeLineHash(50, "same")}` })),
		}, undefined, undefined, { cwd: dir }), (error: Error) => {
			assert.ok(Buffer.byteLength(error.message) <= 16 * 1024);
			assert.match(error.message, /ambiguous checksum matches/);
			assert.match(error.message, /candidates omitted/);
			assert.doesNotMatch(error.message, /same content/);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

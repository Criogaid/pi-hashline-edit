import { computeLineHash } from "../core/hash.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { byteRevision, FileMutationError } from "./file-commit.ts";
import { appendMutationAnchors, finalizeMutationResult, postProcessMutation } from "./mutation-result.ts";

const text = (result: any): string => result.content.map((block: any) => block.text ?? "").join("\n");

function assertFailureByteBudgets(message: string): void {
	const checksAt = message.indexOf("\nInput-anchor checks (this snapshot):\n");
	const guidanceAt = message.indexOf("\nCheck the intended target before retrying;", checksAt);
	assert.ok(checksAt > 0 && guidanceAt > checksAt);
	assert.ok(Buffer.byteLength(message.slice(0, checksAt)) <= 16 * 1024);
	assert.ok(Buffer.byteLength(message.slice(checksAt + 1, guidanceAt)) <= 16 * 1024);
	assert.match(message, /Diagnostic output truncated at 16 KiB/);
	assert.match(message, /Anchor-check output truncated at 16 KiB; omitted entries are not implied matched/);
	const checks = message.match(/^op \d+ \/ anchor \/ .* \/ mismatched$/gm) ?? [];
	assert.ok(checks.length > 40 && checks.length < 1000);
}

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
				assert.equal((text(result).match(/Re-read/g) ?? []).length, 1);
				assert.equal((text(result).match(/\[then_run:stale\]/g) ?? []).length, 1);
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
			assert.match(output, new RegExp(`^${name === "edit" ? 2 : 1}#[0-9A-Z]+$`, "m"));
			assert.doesNotMatch(output, /omitted|truncated/i);
			assert.doesNotMatch(output, /\d+#[0-9A-Z]+│界/);
			assert.ok((await readFile(path, "utf8")).includes(long));
			await writeFile(path, `remove\n${long}\n`);
			const deletion = name === "edit"
				? { edits: [{ op: "delete", anchor: `1#${computeLineHash(1, "remove")}` }] }
				: { find: "remove\n", replace: "" };
			const deleted = await tool.execute(name, { path, ...deletion }, undefined, undefined, { cwd: dir });
			assert.ok(Buffer.byteLength(text(deleted)) < 17 * 1024);
			assert.match(text(deleted), /additional anchors omitted: 16 KiB limit/);
			assert.doesNotMatch(text(deleted), /^\d+#[0-9A-Z]+/m);
		}
		await writeFile(path, "current\n");
		await assert.rejects(makeEditOverride(dir).execute("errors", {
			path, edits: Array.from({ length: 1000 }, () => ({ op: "delete", anchor: "1#XXXX" })),
		}, undefined, undefined, { cwd: dir }), (error: Error) => {
			assertFailureByteBudgets(error.message);
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
			assertFailureByteBudgets(error.message);
			assert.match(error.message, /ambiguous checksum matches/);
			assert.match(error.message, /candidates omitted/);
			assert.doesNotMatch(error.message, /same content/);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("all mutation tools report NUL rejection through the shared Fusion lifecycle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-nul-"));
	try {
		const path = join(dir, "file.txt");
		await writeFile(path, "original\n");
		let commands = 0;
		for (const makeTool of [makeEditOverride, makeReplaceTool, makeWriteOverride]) {
			const events: string[] = [];
			const fusion = createActionFusionExecutor(async () => { commands++; return "unexpected"; }, (event) => events.push(event.command));
			const tool = makeTool(dir, fusion);
			const args = tool.name === "edit" ? { edits: [{ op: "append", body: ["\0"] }] }
				: tool.name === "replace" ? { find: "original", replace: "\0" } : { content: "\0" };
			await assert.rejects(tool.execute("nul", { path, ...args, then_run: { command: "check" } }, undefined, undefined, { cwd: dir }),
				(error: any) => error.publication === "NOT_PUBLISHED" && error.command === "skipped" && /NUL/.test(error.message));
			assert.deepEqual(events, ["waiting", "skipped"]);
			assert.equal(await readFile(path, "utf8"), "original\n");
		}
		assert.equal(commands, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("shared result building preserves publication and appends anchors only to the summary", () => {
	for (const publication of ["NOT_PUBLISHED", "PUBLISHED", "UNKNOWN"] as const) {
		const cause = new Error("render failed");
		assert.throws(() => postProcessMutation("replace", publication, () => { throw cause; }),
			(error: any) => error instanceof FileMutationError && error.stage === "post_process" && error.publication === publication && error.cause === cause);
	}
	const result = { content: [{ type: "text" as const, text: "summary" }, { type: "text" as const, text: "command" }], details: {} };
	assert.deepEqual(appendMutationAnchors(result, " ANCHOR", true).content.map((block: any) => block.text), ["summary ANCHOR", "command"]);
	assert.deepEqual(appendMutationAnchors(result, " ANCHOR", false), result);
	assert.equal(result.content[0].text, "summary");
});

const noOpCases = [
	{ makeTool: makeEditOverride, params: { edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "same")}`, body: ["same"] }] } },
	{ makeTool: makeReplaceTool, params: { find: "same", replace: "same" } },
	{ makeTool: makeWriteOverride, params: { content: "same\n" } },
];

test("all mutation tools succeed without rewriting on no-op, with and without Fusion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-noop-"));
	try {
		for (const { makeTool, params } of noOpCases) {
			for (const mode of ["standalone", "fusion", "command"]) {
				const path = join(dir, "same.txt");
				await writeFile(path, "same\n");
				const before = await stat(path);
				let commands = 0;
				const fusion = createActionFusionExecutor(async () => { commands++; return "checked"; });
				const tool: any = makeTool(dir, mode === "standalone" ? undefined : fusion);
				const result = await tool.execute(tool.name, { path, ...params, ...(mode === "command" ? { then_run: { command: "check" } } : {}) }, undefined, undefined, { cwd: dir });
				assert.match(text(result), /no net change/);
				assert.equal(result.details.publication, "NOT_PUBLISHED");
				const revision = byteRevision(Buffer.from("same\n"));
				for (const key of ["baseRevision", "publishedRevision", "observedRevision", "revision"]) assert.equal(result.details[key], revision);
				assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
				assert.equal(commands, mode === "command" ? 1 : 0);
				if (mode !== "standalone") {
					assert.equal(result.details.actionFusion.command, mode === "command" ? "succeeded" : "not_requested");
					assert.equal(result.details.actionFusion.freshness, "unchanged");
				}
				const after = await stat(path);
				assert.deepEqual([after.ino, after.mtimeMs, after.ctimeMs], [before.ino, before.mtimeMs, before.ctimeMs]);
				assert.equal(await readFile(path, "utf8"), "same\n");
			}
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("no-op Fusion still detects external changes and reports command failures", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-noop-fusion-"));
	try {
		for (const { makeTool, params } of noOpCases) {
			for (const scenario of ["before", "during", "failed"]) {
				const path = join(dir, "same.txt");
				await writeFile(path, "same\n");
				let commands = 0;
				const fusion = createActionFusionExecutor(async () => {
					commands++;
					if (scenario === "failed") throw new Error("check failed");
					await writeFile(path, "external\n");
					return "done";
				}, (progress) => {
					if (scenario === "before" && progress.mutationCompleted && progress.command === "waiting") writeFileSync(path, "external\n");
				});
				const tool: any = makeTool(dir, fusion);
				const result = await tool.execute(tool.name, { path, ...params, then_run: { command: "check" } }, undefined, undefined, { cwd: dir });
				assert.equal(result.details.publication, "NOT_PUBLISHED");
				assert.equal(commands, scenario === "before" ? 0 : 1);
				assert.equal(result.details.actionFusion.command, scenario === "before" ? "skipped" : scenario === "failed" ? "failed" : "succeeded");
				assert.equal(result.details.actionFusion.freshness, scenario === "failed" ? "unchanged" : "changed");
			}
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("mutation anchors omit unchanged positions across distant changes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-anchor-delta-"));
	try {
		const before = Array.from({ length: 100 }, (_, index) => `row ${index + 1}`);
		const after = [...before];
		after[0] = "changed first";
		after[99] = "changed last";
		for (const name of ["edit", "replace"]) {
			const path = join(dir, `${name}.txt`);
			await writeFile(path, before.join("\r\n") + "\r\n");
			const tool = name === "edit" ? makeEditOverride(dir) : makeReplaceTool(dir);
			const params = name === "edit"
				? { edits: [{ op: "replace", anchor: `1#${computeLineHash(1, before[0])}`, end: `100#${computeLineHash(100, before[99])}`, body: after }] }
				: { replacements: [{ find: before[0] + "\r\n", replace: after[0] + "\r\n" }, { find: before[99], replace: after[99] }] };
			const result = await tool.execute(name, { path, ...params }, undefined, undefined, { cwd: dir });
			const returned = [...text(result).matchAll(/^(\d+#[0-9A-Z]+)/gm)].map((match) => match[1]);
			assert.deepEqual(returned, [`1#${computeLineHash(1, after[0])}`, `100#${computeLineHash(100, after[99])}`]);
			assert.doesNotMatch(text(result), /omitted/);
			// An omitted stable row keeps its old anchor; a changed row uses the returned anchor.
			await makeEditOverride(dir).execute("chain", { path, edits: [
				{ op: "replace", anchor: `50#${computeLineHash(50, before[49])}`, body: ["stable anchor reused"] },
				{ op: "replace", anchor: returned[1], body: ["fresh anchor reused"] },
			] }, undefined, undefined, { cwd: dir });
			const final = (await readFile(path, "utf8")).split("\r\n");
			assert.equal(final[49], "stable anchor reused");
			assert.equal(final[99], "fresh anchor reused");
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("mutation anchors retain a deletion successor but omit stable rows and deleted EOF", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-anchor-delete-"));
	try {
		for (const name of ["edit", "replace"]) {
			for (const atEnd of [false, true]) {
				const path = join(dir, `${name}.txt`);
				const lines = atEnd ? ["a", "c", "remove"] : ["a", "remove", "c", "d"];
				await writeFile(path, lines.join("\n") + "\n");
				const tool = name === "edit" ? makeEditOverride(dir) : makeReplaceTool(dir);
				const line = atEnd ? 3 : 2;
				const params = name === "edit"
					? { edits: [{ op: "delete", anchor: `${line}#${computeLineHash(line, "remove")}` }] }
					: { find: "remove\n", replace: "" };
				const result = await tool.execute(name, { path, ...params }, undefined, undefined, { cwd: dir });
				const rows = text(result).split("\n").filter((row) => /^\d+#/.test(row));
				assert.deepEqual(rows, atEnd ? [] : [`2#${computeLineHash(2, "c")}│c`]);
			}
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("compact mutation anchors exceed forty rows and stop only at the byte budget", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-compact-budget-"));
	try {
		for (const name of ["edit", "replace"]) {
			for (const count of [80, 3000]) {
				const path = join(dir, `${name}.txt`);
				await writeFile(path, "before\n");
				const inserted = Array.from({ length: count }, (_, i) => `changed ${i}`);
				const tool = name === "edit" ? makeEditOverride(dir) : makeReplaceTool(dir);
				const params = name === "edit"
					? { edits: [{ op: "append", body: inserted }] }
					: { find: "before", replace: inserted.join("\n") };
				const result = await tool.execute(name, { path, ...params }, undefined, undefined, { cwd: dir });
				const output = text(result);
				const rows = [...output.matchAll(/^(\d+)#([0-9A-Z]+)$/gm)];
				assert.ok(rows.length > 40);
				assert.doesNotMatch(output, /│/);
				const anchorBlock = output.slice(output.indexOf("\nUpdated anchors:"));
				assert.ok(Buffer.byteLength(anchorBlock) <= 16 * 1024);
				if (count === 80) {
					assert.equal(rows.length, count);
					assert.doesNotMatch(output, /omitted/);
				} else {
					assert.ok(rows.length < count);
					assert.match(output, /additional anchors omitted: 16 KiB limit/);
				}
				const finalLines = (await readFile(path, "utf8")).trimEnd().split("\n");
				for (const [, line, hash] of rows) assert.equal(hash, computeLineHash(Number(line), finalLines[Number(line) - 1]));
			}
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

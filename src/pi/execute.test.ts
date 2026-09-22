/**
 * pi integration execute tests: drive the real makeReadOverride/makeEditOverride
 * execute, covering text read with anchors, the hashline edit round-trip,
 * chained edits via returned anchors, and error returns with isError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, initTheme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerHashline from "../index.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { getState } from "./state.ts";
import { computeLineHash } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { byteRevision } from "./file-commit.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

/** Anchor a model would copy from read output for `line` of `text` (1-based). */
function h(text: string, line: number) {
	return `${line}#${computeLineHash(line, splitLines(text)[line - 1])}`;
}

/** Extract a `LINE#HASH` anchor from a read/edit result text block. */
function anchorLine(block: string, line: number) {
	const m = new RegExp(`^${line}#([0-9A-Z]+)(?:│|$)`, "m").exec(block);
	if (!m) throw new Error(`line ${line} anchor not found in block`);
	return `${line}#${m[1]}`;
}

test("read execute: text outputs LINE#HASH│content", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "line1\nline2\n");
		const r: any = await call(makeReadOverride(dir), { path: "f.txt" });
		const text = r.content[0];
		assert.equal(text.type, "text");
		assert.match(text.text, /1#[0-9A-Z]+│line1/);
		assert.match(text.text, /2#[0-9A-Z]+│line2/);
		assert.match(text.text, /f\.txt · 2 lines/);
	});
});

test("read execute: a missing final newline is stated in the header", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "line1\nline2");
		const bare: any = await call(makeReadOverride(dir), { path: "f.txt" });
		assert.match(bare.content[0].text, /f\.txt · 2 lines · no trailing newline/);

		await writeFile(join(dir, "g.txt"), "line1\nline2\n");
		const terminated: any = await call(makeReadOverride(dir), { path: "g.txt" });
		assert.doesNotMatch(terminated.content[0].text, /no trailing newline/);
	});
});

test("edit execute: a file without a final newline stays byte-exact", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		// The benchmark's literal-1-no-final-newline fixture: no terminator, plus a
		// word-joiner the model cannot see. Only line 2 may change; the missing
		// terminator must not turn into a new byte.
		const text = "guard\nold value\u2060";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["new value\u2060"] }],
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "guard\nnew value\u2060");
	});
});

test("edit execute: hashline round-trip (read → edit → file changed)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
	});
});

test("edit execute: multiple ops in one call", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [
				{ op: "insert_after", anchor: h(text, 3), body: ["z"] },
				{ op: "replace", anchor: h(text, 1), body: ["A"] },
			],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nb\nc\nz\n");
	});
});

test("edit result returns Updated anchors that chain the next edit without a re-read", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		// first edit (model cites the read anchor for line 1)
		const r1: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
		});
		assert.equal(r1.isError, undefined);
		const out: string = r1.content[0].text;
		assert.match(out, /Updated anchors/);
		assert.doesNotMatch(out, /│/);
		// second edit chains on the anchor returned by the first edit — no read in between
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: anchorLine(out, 1), body: ["AA"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "AA\nb\nc\n");
	});
});

test("edit result anchors cover an inserted block (chain an edit inside it)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		const r1: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "insert_after", anchor: h(text, 2), body: ["c", "d", "e"] }],
		});
		assert.equal(r1.isError, undefined);
		const out: string = r1.content[0].text;
		// line 4 (d, one of the inserted lines) must be anchored in the result
		const a4 = anchorLine(out, 4);
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: a4, body: ["DD"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "a\nb\nc\nDD\ne\n");
	});
});

test("unrelated external change does NOT block an edit on a stable line", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		// simulate an external change at line 3 between read and edit
		await writeFile(f, "a\nb\nCHANGED\n");
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nb\nCHANGED\n");
	});
});

test("edit on a line that changed externally → anchor mismatch", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await writeFile(f, "a\nBCHANGED\nc\n"); // line 2 changed
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: h(text, 2), body: ["x"] }],
			}),
			/anchor|re-read/i,
		);
	});
});

test("unresolved anchor context supplies a fresh nearby token for a verified retry", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "recover.txt");
		const observed = ["one", "two", "three", "four", "old marker", "six", "seven", "eight"].join("\n") + "\n";
		await writeFile(file, ["one", "two", "three", "four", "changed", "six", "new marker", "eight"].join("\n") + "\n");
		const edit = makeEditOverride(dir);
		let retryAnchor = "";
		await assert.rejects(call(edit, {
			path: "recover.txt",
			edits: [{ op: "replace", anchor: h(observed, 5), body: ["updated"] }],
		}), (error: Error) => {
			assert.match(error.message, /Anchor mismatch: 1 unresolved/);
			assert.match(error.message, /No changes written by this edit batch/);
			assert.match(error.message, /@@ lines 2-8 @@/);
			retryAnchor = /^(7#[0-9A-Z]+)│new marker$/m.exec(error.message)?.[1] ?? "";
			return retryAnchor !== "";
		});
		await call(edit, { path: "recover.txt", edits: [{ op: "replace", anchor: retryAnchor, body: ["updated"] }] });
		assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\nfour\nchanged\nsix\nupdated\neight\n");
	});
});

test("edit execute: no read before edit → anchor verification fails", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: "1#XXXX", body: ["A"] }],
			}),
			/anchor|re-read/i,
		);
	});
});

test("edit execute: empty edits → throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeEditOverride(dir), { path: "f.txt", edits: [] }),
			/empty|missing/i,
		);
	});
});

test("edit execute: malformed op (replace without body) → throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: "1#XX" }],
			}),
			/body/i,
		);
	});
});

test("edit execute: delete op", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "delete", anchor: h(text, 2) }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "a\nc\n");
	});
});

test("disabled config registers no tools — built-ins remain", async () => {
	await withDir(async (dir) => {
		const oldCwd = process.cwd();
		const state = getState();
		const previous = state.config;
		try {
			await mkdir(join(dir, ".pi"));
			await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { enabled: false } }));
			await writeFile(join(dir, "f.txt"), "old value\n");
			process.chdir(dir);
			const registered: string[] = [];
			registerHashline({ on() {}, registerTool(tool: { name: string }) { registered.push(tool.name); } } as any);
			assert.deepEqual(registered, []);
			const builtin = createEditTool(dir);
			const params = validateToolArguments(builtin, {
				name: "edit", arguments: { path: "f.txt", edits: [{ oldText: "old value", newText: "new value" }] },
			} as any);
			await call(builtin, params);
			assert.equal(await readFile(join(dir, "f.txt"), "utf-8"), "new value\n");
		} finally {
			process.chdir(oldCwd);
			state.config = previous;
		}
	});
});

// --- renderer regression guards (details.diff must be a string, renderResult must not throw) ---

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("edit success: details.diff is a string (not the generateDiffString object)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
		assert.equal(typeof r.details.diff, "string", "details.diff must be a string");
		assert.equal(typeof r.details.patch, "string");
		assert.equal(typeof r.details.firstChangedLine, "number");
	});
});

test("edit success: renderResult renders the diff without throwing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
	// @ts-ignore — drive the renderer with a stub theme
		const comp: any = edit.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, { isError: r.isError ?? false, state: {}, invalidate: () => {} });
		assert.ok(typeof comp?.text === "string");
		assert.ok(comp.text.includes("B"), "rendered diff should contain the new content");
	});
});

test("edit header: renderResult refreshes the call header in place — no invalidate", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\nd\ne\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [
				{ op: "replace", anchor: h(text, 2), end: h(text, 3), body: ["B"] },
				{ op: "insert_after", anchor: h(text, 5), body: ["f", "g"] },
			],
		});
		const args = { path: "f.txt", edits: [{ op: "replace" as const }] };
		let invalidated = false;
		const context: any = { args, isError: false, state: {}, invalidate: () => { invalidated = true; } };
		// first pass: renderCall builds the header; no counts exist yet
		const header: any = edit.renderCall(args, stubTheme, context);
		assert.ok(!header.text.includes("+3"), "pre-execution header must not show counts");
		// result lands: renderResult refreshes the SAME component in place
		edit.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, context);
		assert.deepEqual(context.state.diffCounts, { added: 3, removed: 2 });
		assert.ok(header.text.includes("+3"), "header should show added count");
		assert.ok(header.text.includes("-2"), "header should show removed count");
		// refreshing via context.invalidate() re-enters updateDisplay and renders
		// the diff twice — the renderer must never call it
		assert.ok(!invalidated, "renderResult must not call invalidate");
		// later full passes (expand/collapse) re-run renderCall; counts survive in state
		const header2: any = edit.renderCall(args, stubTheme, { args, state: context.state, lastComponent: header });
		assert.equal(header2, header, "renderCall reuses the stashed component");
		assert.ok(header2.text.includes("+3"), "re-render keeps the counts");
	});
});

test("edit error: renderResult renders the error line without throwing", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const edit = makeEditOverride(dir);
		let thrown: any;
		await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: "1#XXXX", body: ["A"] }],
		}).catch((e: any) => {
			thrown = e;
		});
		assert.ok(thrown, "expected the edit to throw");
		// @ts-ignore — simulate the framework handing the thrown message to renderResult
		const comp: any = edit.renderResult(
			{ content: [{ type: "text", text: thrown.message }] },
			{ isPartial: false, expanded: false },
			stubTheme,
			{ isError: true },
		);
		assert.ok(typeof comp?.text === "string");
	});
});

test("hash length stays 4 even for runs of identical lines (no explosion)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "\n\n\n\ncode\n");
		const r: any = await call(makeReadOverride(dir), { path: "f.txt" });
		const text: string = r.content[0].text;
		for (const m of text.matchAll(/\d+#([0-9A-Z]+)│/g)) {
			assert.equal(m[1].length, 4, `anchor ${m[0]} hash is not 4 chars`);
		}
	});
});

test("read byte truncation counts UTF-8 and separators without cutting anchors", async () => withDir(async (dir) => {
	const maxBytes = 256 * 1024;
	const hashLen = getState().config.hashLen;
	const prefixBytes = Buffer.byteLength(`1#${"X".repeat(hashLen)}│`);
	const first = "界".repeat(40000);
	const second = "x".repeat(maxBytes - Buffer.byteLength(first) - 2 * prefixBytes);
	await writeFile(join(dir, "large.txt"), `${first}\n${second}\n`);
	const result = await call(makeReadOverride(dir), { path: "large.txt" });
	assert.equal(result.details.truncation.outputLines, 1);
	assert.equal(result.details.truncation.truncatedBy, "bytes");
	assert.match(result.content[0].text, /truncated at 256KB/);
	assert.ok(result.content[0].text.includes(`1#${computeLineHash(1, first, hashLen)}│${first}\n`));
	assert.doesNotMatch(result.content[0].text, /\n2#/);
	const next = await call(makeReadOverride(dir), { path: "large.txt", offset: 2, limit: 1 });
	assert.ok(next.content[0].text.includes(`2#${computeLineHash(2, second, hashLen)}│${second}`));
}));

test("read reports an oversized first row without suggesting an ineffective retry", async () => withDir(async (dir) => {
	await writeFile(join(dir, "long.txt"), "x".repeat(256 * 1024));
	const result = await call(makeReadOverride(dir), { path: "long.txt" });
	assert.equal(result.details.truncation.firstLineExceedsLimit, true);
	assert.equal(result.details.truncation.outputLines, 0);
	assert.match(result.content[0].text, /cannot return a complete anchor row/);
	assert.doesNotMatch(result.content[0].text, /use offset\/limit/);
}));

test("read preserves empty files and explicit limits above the native default", async () => withDir(async (dir) => {
	await writeFile(join(dir, "empty.txt"), "");
	const empty = await call(makeReadOverride(dir), { path: "empty.txt" });
	assert.match(empty.content[0].text, /0 lines/);
	assert.equal(empty.details, undefined);
	await writeFile(join(dir, "many.txt"), "x\n".repeat(2001));
	const many = await call(makeReadOverride(dir), { path: "many.txt", limit: 2001 });
	assert.match(many.content[0].text, /\n2001#[0-9A-Z]+│x/);
	assert.equal(many.details, undefined);
}));

test("native read and write renderers preserve resource titles, previews, and full errors", async () => withDir(async (dir) => {
	const context = { cwd: dir, state: {}, argsComplete: true, expanded: false, isPartial: false, lastComponent: undefined };
	const read = makeReadOverride(dir);
	const readCall = read.renderCall!({ path: "SKILL.md", offset: 2, limit: 3 }, stubTheme as any, { ...context, args: { path: "SKILL.md" } } as any);
	assert.match(readCall.render(120).join("\n"), /\[skill\]/);
	const write = makeWriteOverride(dir);
	const writeCall = write.renderCall({ path: "preview.txt", content: "native content preview\n" }, stubTheme, context);
	assert.match(writeCall.render(120).join("\n"), /native content preview/);
	const error = write.renderResult({ content: [{ type: "text", text: "first error\nsecond error" }] }, { isPartial: false, expanded: false }, stubTheme, { ...context, isError: true });
	assert.match(error.render(120).join("\n"), /first error[\s\S]*second error/);
}));

test("copied string anchors validate and replace an inclusive range", async () => withDir(async (dir) => {
	const original = "a\nb\nc\nd\n";
	await writeFile(join(dir, "range.txt"), original);
	const read = await call(makeReadOverride(dir), { path: "range.txt" });
	const edit = makeEditOverride(dir);
	const args = validateToolArguments(edit as any, { type: "toolCall", id: "range", name: "edit", arguments: { path: "range.txt", edits: [{ op: "replace", anchor: anchorLine(read.content[0].text, 2), end: anchorLine(read.content[0].text, 3), body: ["merged"] }] } });
	await call(edit, args);
	assert.equal(await readFile(join(dir, "range.txt"), "utf8"), "a\nmerged\nd\n");
}));

test("invalid anchors and conflicting fields fail before changing the file", async () => withDir(async (dir) => {
	const original = "a\nb\n";
	await writeFile(join(dir, "invalid.txt"), original);
	const edit = makeEditOverride(dir);
	const anchor = h(original, 1);
	const invalid = [
		{ op: "replace", anchor: { line: 1, hash: anchor.split("#")[1] }, body: ["changed"] },
		...['0#AB', '-1#AB', '1.5#AB', '1#', '1#ab', '1#AB│a', '9007199254740993#AB'].map(anchor => ({ op: "replace", anchor, body: ["changed"] })),
		{ op: "insert_after", anchor, end: anchor, body: ["changed"] },
		{ op: "append", anchor, body: ["changed"] },
		{ op: "delete", anchor, body: ["changed"] },
	];
	for (const operation of invalid) {
		await assert.rejects(call(edit, { path: "invalid.txt", edits: [operation] }), /Invalid anchor|does not accept/);
		assert.equal(await readFile(join(dir, "invalid.txt"), "utf8"), original);
	}
	assert.throws(() => validateToolArguments(edit as any, { type: "toolCall", id: "invalid", name: "edit", arguments: { path: "invalid.txt", edits: [invalid[0]] } as any }));
}));

test("shifted-anchor recovery returns a token that can be copied into the retry", async () => withDir(async (dir) => {
	const original = "a\nb\n";
	await writeFile(join(dir, "shift.txt"), "prefix\n" + original);
	const edit = makeEditOverride(dir);
	let replacement = "";
	await assert.rejects(call(edit, { path: "shift.txt", edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }] }), (error: Error) => {
		replacement = /^(3#[0-9A-Z]+)│b$/m.exec(error.message)?.[1] ?? "";
		assert.match(error.message, /Check the intended target/);
		return replacement !== "";
	});
	await call(edit, { path: "shift.txt", edits: [{ op: "replace", anchor: replacement, body: ["B"] }] });
	assert.equal(await readFile(join(dir, "shift.txt"), "utf8"), "prefix\na\nB\n");
}));

test("shifted-anchor recovery keeps the read fallback for oversized candidates", async () => withDir(async (dir) => {
	const oversized = "x".repeat(4 * 1024);
	const original = `a\n${oversized}\n`;
	await writeFile(join(dir, "shift-large.txt"), `prefix\n${original}`);
	const edit = makeEditOverride(dir);
	await assert.rejects(call(edit, { path: "shift-large.txt", edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }] }), (error: Error) => {
		assert.match(error.message, /Candidate content exceeds 4096 bytes/);
		assert.match(error.message, /use read or grep/);
		assert.doesNotMatch(error.message, new RegExp(`│x{${oversized.length}}`));
		return true;
	});
}));

test("failed commands preserve mutation results and stay out of all main card renderers", async () => withDir(async (dir) => {
	const commands: string[] = [];
	const fusion = createActionFusionExecutor(async () => { throw new Error("command-only diagnostic\nCommand exited with code 7"); }, event => commands.push(event.command));
	const cases = [
		{ tool: makeEditOverride(dir, fusion), args: { path: "edit.txt", edits: [{ op: "append", body: ["after"] }] }, expected: "before\nafter\n" },
		{ tool: makeReplaceTool(dir, fusion), args: { path: "replace.txt", find: "before", replace: "after" }, expected: "after\n" },
		{ tool: makeWriteOverride(dir, fusion), args: { path: "write.txt", content: "after\n" }, expected: "after\n" },
	];
	for (const { tool, args, expected } of cases) {
		await writeFile(join(dir, args.path), "before\n");
		const result = await tool.execute(args.path, { ...args, then_run: { command: "check" } }, undefined, undefined, { cwd: dir });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.actionFusion.command, "failed");
		assert.match(result.content.at(-1).text, /then_run:failed[\s\S]*command-only diagnostic/);
		if (tool.name !== "write") assert.equal(typeof result.details.diff, "string");
		const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, stubTheme, { args, state: {}, cwd: dir, isError: false });
		assert.doesNotMatch(rendered.render(120).join("\n"), /command-only diagnostic|then_run:failed/);
		assert.equal(await readFile(join(dir, args.path), "utf8"), expected);
	}
	assert.deepEqual(commands, cases.flatMap(() => ["waiting", "waiting", "running", "failed"]));
}));

test("text tools reject malformed UTF-8 and NUL bytes without rewriting source bytes", async () => withDir(async (dir) => {
	const target = join(dir, "invalid-utf8.txt");
	const original = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]);
	await writeFile(target, original);
	await assert.rejects(call(makeReadOverride(dir), { path: "invalid-utf8.txt" }), /UNSUPPORTED_ENCODING/);
	await assert.rejects(call(makeEditOverride(dir), { path: "invalid-utf8.txt", edits: [{ op: "append", body: ["x"] }] }), /UNSUPPORTED_ENCODING/);
	await assert.rejects(call(makeReplaceTool(dir), { path: "invalid-utf8.txt", find: "a", replace: "b" }), /UNSUPPORTED_ENCODING/);
	assert.deepEqual(await readFile(target), original);

	const nulTarget = join(dir, "nul.txt");
	const nulOriginal = Buffer.from([0x61, 0x00, 0x62]);
	await writeFile(nulTarget, nulOriginal);
	await assert.rejects(call(makeEditOverride(dir), { path: "nul.txt", edits: [{ op: "append", body: ["x"] }] }), /UNSUPPORTED_TEXT/);
	await assert.rejects(call(makeReplaceTool(dir), { path: "nul.txt", find: "a", replace: "b" }), /UNSUPPORTED_TEXT/);
	assert.deepEqual(await readFile(nulTarget), nulOriginal);
}));

test("edit rejects embedded line terminators even when schema validation is bypassed", async () => withDir(async (dir) => {
	const target = join(dir, "body.txt");
	await writeFile(target, "a\n");
	await assert.rejects(call(makeEditOverride(dir), { path: "body.txt", edits: [{ op: "append", body: ["x\ny"] }] }), /INVALID_BODY/);
	assert.equal(await readFile(target, "utf8"), "a\n");
	assert.throws(() => validateToolArguments(makeEditOverride(dir) as any, { type: "toolCall", id: "body", name: "edit", arguments: { path: "body.txt", edits: [{ op: "append", body: ["x\ny"] }] } }));
}));

test("edit preserves a UTF-8 BOM and reports bound mutation revisions", async () => withDir(async (dir) => {
	const target = join(dir, "bom.txt");
	const original = Buffer.from("\ufeffguard\nold\n", "utf8");
	await writeFile(target, original);
	const result: any = await call(makeEditOverride(dir), { path: "bom.txt", edits: [{ op: "replace", anchor: h("\ufeffguard\nold\n", 2), body: ["new"] }] });
	const expected = Buffer.from("\ufeffguard\nnew\n", "utf8");
	assert.deepEqual(await readFile(target), expected);
	assert.equal(result.details.baseRevision, byteRevision(original));
	assert.equal(result.details.publishedRevision, byteRevision(expected));
	assert.equal(result.details.observedRevision, result.details.publishedRevision);
	assert.equal(result.details.revision, result.details.publishedRevision);
}));

test("edit and replace reject NUL output without rewriting source bytes", async () => withDir(async (dir) => {
	const target = join(dir, "output.txt");
	const original = Buffer.from("\ufeffbefore\r\n", "utf8");
	await writeFile(target, original);
	await assert.rejects(call(makeEditOverride(dir), { path: "output.txt", edits: [{ op: "append", body: ["bad\0text"] }] }), /UNSUPPORTED_TEXT/);
	assert.deepEqual(await readFile(target), original);
	await assert.rejects(call(makeReplaceTool(dir), { path: "output.txt", find: "before", replace: "bad\0text" }), /UNSUPPORTED_TEXT/);
	assert.deepEqual(await readFile(target), original);
}));

test("failed edits expose input status and candidate code for a verified fused retry", async () => withDir(async (dir) => {
	const original = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`);
	original[4] = "if (!fusion) throw new Error();";
	original[5] = "const absolutePath = canonicalPath(cwd, path);";
	const before = `prefix\n${original.join("\n")}\n`;
	const file = join(dir, "candidate.txt");
	await writeFile(file, before);
	let commands = 0;
	const fusion = createActionFusionExecutor(async () => { commands++; return "checked"; });
	const edit = makeEditOverride(dir, fusion);
	const stale = h(original.join("\n"), 5);
	const stable = h(before, 12);
	const candidate = h(before, 6);
	let message = "";
	await assert.rejects(edit.execute("failed", {
		path: file,
		edits: [
			{ op: "insert_after", anchor: stale, body: ["const hashLen = 4;"] },
			{ op: "replace", anchor: stable, body: ["changed"] },
		],
		then_run: { command: "check" },
	}, undefined, undefined, { cwd: dir }), (error: Error) => { message = error.message; return true; });
	assert.match(message, /then_run:skipped/);
	assert.ok(message.includes(`op 0 / anchor / ${stale} / mismatched`));
	assert.ok(message.includes(`op 1 / anchor / ${stable} / matched`));
	assert.ok(message.includes(`checksum-matching candidate ${candidate}.`));
	assert.equal(message.split(`${candidate}│${original[4]}`).length - 1, 1);
	assert.doesNotMatch(message, /0 omitted|Limits:/);
	const context = message.split("Unique-candidate neighborhoods")[1];
	assert.ok(context);
	for (let line = 3; line <= 9; line++) assert.equal(anchorLine(context, line), h(before, line));
	assert.ok(context.includes(`${h(before, 7)}│${original[5]}`));
	assert.doesNotMatch(context, /^12#[0-9A-Z]+│/m);
	assert.equal(await readFile(file, "utf8"), before);
	assert.equal(commands, 0);
	await edit.execute("retry", {
		path: file,
		edits: [
			{ op: "insert_after", anchor: anchorLine(context, 6), body: ["const hashLen = 4;"] },
			{ op: "replace", anchor: stable, body: ["changed"] },
		],
		then_run: { command: "check" },
	}, undefined, undefined, { cwd: dir });
	const expected = splitLines(before);
	expected[11] = "changed";
	expected.splice(6, 0, "const hashLen = 4;");
	assert.equal(await readFile(file, "utf8"), `${expected.join("\n")}\n`);
	assert.equal(commands, 1);
}));

test("input status distinguishes skipped checks and expires before the next retry", async () => withDir(async (dir) => {
	const before = "a\nb\nc\n";
	const file = join(dir, "checks.txt");
	await writeFile(file, before);
	const edit = makeEditOverride(dir);
	const stable = h(before, 1);
	await assert.rejects(call(edit, { path: file, edits: [{ op: "replace", anchor: stable, body: ["bad\nline"] }] }), (error: Error) => {
		assert.ok(error.message.includes(`op 0 / anchor / ${stable} / not_checked`));
		assert.doesNotMatch(error.message, /\/ matched/);
		return true;
	});
	await assert.rejects(call(edit, { path: file, edits: [
		{ op: "replace", anchor: stable, body: ["A"] },
		{ op: "delete", anchor: h(before, 2), end: "3#ZZ" },
	] }), (error: Error) => {
		assert.ok(error.message.includes(`op 0 / anchor / ${stable} / matched`));
		assert.match(error.message, /op 1 \/ end \/ 3#ZZ \/ mismatched/);
		assert.match(error.message, /Anchor checks only; retries revalidate/);
		return true;
	});
	assert.equal(await readFile(file, "utf8"), before);
	await writeFile(file, "changed\nb\nc\n");
	await assert.rejects(call(edit, { path: file, edits: [{ op: "replace", anchor: stable, body: ["A"] }] }), (error: Error) => {
		assert.ok(error.message.includes(`op 0 / anchor / ${stable} / mismatched`));
		return true;
	});
	assert.equal(await readFile(file, "utf8"), "changed\nb\nc\n");
}));

test("large failed batches bound status and candidate mappings without implying omitted checks matched", async () => withDir(async (dir) => {
	const original = "a\ntarget\nz\n";
	const before = `prefix\n${original}`;
	const file = join(dir, "many-checks.txt");
	await writeFile(file, before);
	const edits = Array.from({ length: 45 }, () => ({ op: "replace", anchor: h(original, 2), body: ["changed"] }));
	await assert.rejects(call(makeEditOverride(dir), { path: file, edits }), (error: Error) => {
		assert.match(error.message, /Anchor checks: 40\/45; 5 omitted/);
		assert.match(error.message, /5 failure details omitted/);
		assert.equal((error.message.match(/^op \d+ \/ anchor \/ .* \/ mismatched$/gm) ?? []).length, 40);
		assert.equal((error.message.match(/checksum-matching candidate/g) ?? []).length, 40);
		assert.equal((error.message.match(/^3#[0-9A-Z]+│target$/gm) ?? []).length, 1);
		assert.doesNotMatch(error.message, /\/ matched/);
		return true;
	});
	assert.equal(await readFile(file, "utf8"), before);
}));

test("compact edit anchors retain only untouched deletion successors in mixed batches", async () => withDir(async (dir) => {
	const before = "a\nb\nc\nd\ne\nf\ng\n";
	const file = join(dir, "mixed.txt");
	await writeFile(file, before);
	const edit = makeEditOverride(dir);
	const result = await call(edit, { path: file, edits: [
		{ op: "delete", anchor: h(before, 6) },
		{ op: "replace", anchor: h(before, 4), body: ["D"] },
		{ op: "delete", anchor: h(before, 3) },
		{ op: "replace", anchor: h(before, 1), body: ["A", "X"] },
	] });
	const after = "A\nX\nb\nD\ne\ng\n";
	assert.equal(await readFile(file, "utf8"), after);
	const output = result.content[0].text;
	assert.deepEqual(output.split("\n").filter((line: string) => /^\d+#/.test(line)), [
		h(after, 1), h(after, 2), h(after, 4), `${h(after, 6)}│g`,
	]);
	await call(edit, { path: file, edits: [{ op: "replace", anchor: anchorLine(output, 6), body: ["G"] }] });
	assert.equal(await readFile(file, "utf8"), "A\nX\nb\nD\ne\nG\n");
}));

test("candidate content falls back to one complete row when its neighborhood is truncated", async () => withDir(async (dir) => {
	const original = "header\ntarget\ntail\n";
	const before = `header\n${"x".repeat(17000)}\ntarget\ntail\n`;
	const file = join(dir, "fallback.txt");
	await writeFile(file, before);
	let candidate = "";
	await assert.rejects(call(makeEditOverride(dir), { path: file, edits: [
		{ op: "replace", anchor: h(original, 2), body: ["updated"] },
	] }), (error: Error) => {
		candidate = anchorLine(error.message, 3);
		assert.equal((error.message.match(/^3#[0-9A-Z]+│target$/gm) ?? []).length, 1);
		assert.match(error.message, /neighborhoods truncated: byte limit/);
		assert.doesNotMatch(error.message.split("Unique-candidate neighborhoods")[1], /^3#/m);
		return true;
	});
	assert.equal(await readFile(file, "utf8"), before);
	await call(makeEditOverride(dir), { path: file, edits: [{ op: "replace", anchor: candidate, body: ["updated"] }] });
	assert.equal(await readFile(file, "utf8"), before.replace("target", "updated"));
}));

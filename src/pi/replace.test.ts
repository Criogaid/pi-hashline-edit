/**
 * pi integration tests for the `replace` tool: literal replaceAll, regex with
 * capture groups, flags, the maxMatches guard, 0-match / invalid-pattern
 * failures (signaled by throwing — pi's failure contract), diff + fresh-anchor
 * return, and chaining a hashline `edit` on an anchor returned by `replace`.
 *
 * Failures are signaled by throwing (see edit-tool.ts); tests use assert.rejects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createActionFusionExecutor } from "./action-fusion.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-replace-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

/** Extract a `LINE#HASH` anchor for `line` from a result text block. */
function anchorLine(block: string, line: number) {
	const m = new RegExp(`^${line}#([0-9A-Z]+)(?:│|$)`, "m").exec(block);
	if (!m) throw new Error(`line ${line} anchor not found in block`);
	return `${line}#${m[1]}`;
}

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("replace guidance distinguishes literal LF from a visible escape", () => {
	const tool = makeReplaceTool(process.cwd());
	const description = JSON.stringify(tool.parameters.properties.find);
	assert.match(description, /In literal mode \(default\), an actual LF matches a line boundary/);
	assert.match(description, /backslash followed by n matches those two source characters/);
	assert.match(description, /In regex mode/);
});

test("replace literal: replaces all occurrences", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "foo bar foo baz foo\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "foo", replace: "qux" });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "qux bar qux baz qux\n");
		assert.match(r.content[0].text, /3 matches/);
	});
});

test("literal multiline replace matches LF and CRLF while retaining local separators", async () => withDir(async (dir) => {
	const file = join(dir, "mixed.txt");
	await writeFile(file, "\uFEFFhead\r\nold\r\none\r\nmid\nold\none\nend\r\n");
	const result: any = await call(makeReplaceTool(dir), { path: "mixed.txt", find: "old\none", replace: "NEW\nX" });
	assert.match(result.content[0].text, /2 matches/);
	assert.equal(await readFile(file, "utf8"), "\uFEFFhead\r\nNEW\r\nX\r\nmid\nNEW\nX\nend\r\n");
	await call(makeReplaceTool(dir), { path: "mixed.txt", find: "NEW\r\nX", replace: "done" });
	assert.equal(await readFile(file, "utf8"), "\uFEFFhead\r\ndone\r\nmid\ndone\nend\r\n");
}));

test("both replacement modes preserve each matched separator", async () => withDir(async (dir) => {
	const file = join(dir, "mixed.txt");
	for (const regex of [false, true]) {
		await writeFile(file, "a\r\nb\nc\r\ntail\n");
		await call(makeReplaceTool(dir), { path: "mixed.txt", find: "a\nb\nc", replace: "x\ny\nz\nextra", regex });
		assert.equal(await readFile(file, "utf8"), "x\r\ny\nz\nextra\r\ntail\n");
	}
}));

test("literal replacement uses one LF view and preserves raw bytes across query styles", async () => withDir(async (dir) => {
	const file = join(dir, "f.txt");
	for (const find of ["a\nb\nc", "a\r\nb\r\nc", "a\r\nb\nc"]) {
		const before = "\uFEFFhead\r\na\r\nb\nc\rtail";
		await writeFile(file, before);
		const result = await call(makeReplaceTool(dir), { path: file, find, replace: find });
		assert.equal(await readFile(file, "utf8"), before);
		assert.match(result.content[0].text, /no net change/);
	}
	for (const [before, find, replacement, expected] of [
		["a\r\nb", "a", "A\nextra", "A\r\nextra\r\nb"],
		["a\nb", "a\r\nb", "A\r\nB", "A\nB"],
		["a\r\nb", "\n", "", "ab"],
		["a\r\nb", "\n", "\n", "a\r\nb"],
		["a\rb\r\r\nc", "a\rb\r\r\nc", "x\ry\r\r\nz", "x\ry\r\r\nz"],
	]) {
		await writeFile(file, before);
		await call(makeReplaceTool(dir), { path: file, find, replace: replacement });
		assert.equal(await readFile(file, "utf8"), expected);
	}
}));

test("mixed literal and regex batches share raw offsets after CRLF normalization", async () => withDir(async (dir) => {
	const file = join(dir, "f.txt");
	await writeFile(file, "😀\r\na\r\nb\r\nc");
	await call(makeReplaceTool(dir), { path: file, replacements: [
		{ find: "a\nb", replace: "A\nB" },
		{ find: "(c)$", replace: "$1!", regex: true },
	] });
	assert.equal(await readFile(file, "utf8"), "😀\r\nA\r\nB\r\nc!");
	const before = await readFile(file, "utf8");
	await assert.rejects(call(makeReplaceTool(dir), { path: file, replacements: [
		{ find: "A\nB", replace: "x" },
		{ find: "\\nB", replace: "y", regex: true },
	] }), /overlap/);
	assert.equal(await readFile(file, "utf8"), before);
}));

test("replace literal: $ in replacement stays literal (no expansion)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "cost: $5 here\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "$5", replace: "$10" });
		assert.equal(r.isError, undefined);
		// literal mode: "$10" inserted verbatim, NOT interpreted as group-10 + "0"
		assert.equal(await readFile(f, "utf-8"), "cost: $10 here\n");
	});
});

test("replace literal: case-insensitive via flags", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "Foo fOo FOO\n");
		await call(makeReplaceTool(dir), { path: "f.txt", find: "foo", replace: "x", flags: "i" });
		assert.equal(await readFile(f, "utf-8"), "x x x\n");
	});
});

test("replace regex: capture groups in replacement", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "name: alice\nname: bob\n");
		await call(makeReplaceTool(dir), {
			path: "f.txt",
			find: "name: (\\w+)",
			replace: "user: $1",
			regex: true,
		});
		assert.equal(await readFile(f, "utf-8"), "user: alice\nuser: bob\n");
	});
});

test("replace regex: multiline flag matches line-anchored pattern", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		// without `m`, ^a$ wouldn't match (a isn't at end of string); with `m` it does
		await call(makeReplaceTool(dir), { path: "f.txt", find: "^a$", replace: "A", regex: true, flags: "m" });
		assert.equal(await readFile(f, "utf-8"), "A\nb\nc\n");
	});
});

test("replace regex: dotall flag makes . match newlines", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		// a.b only matches across the newline with the `s` (dotall) flag
		await call(makeReplaceTool(dir), { path: "f.txt", find: "a.b", replace: "X", regex: true, flags: "s" });
		assert.equal(await readFile(f, "utf-8"), "X\n");
	});
});

test("replace: 0 matches throws", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "zzz", replace: "y" }),
			/no matches/,
		);
		assert.equal(await readFile(f, "utf-8"), "a\nb\n", "file untouched on 0-match failure");
	});
});

test("replace: empty find throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "", replace: "x" }),
			/`find` is empty/,
		);
	});
});

test("replace: maxMatches guard throws before writing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a".repeat(20) + "\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "a", replace: "b", maxMatches: 5 }),
			/exceed `maxMatches`/,
		);
		assert.equal(await readFile(f, "utf-8"), "a".repeat(20) + "\n", "file untouched when guard trips");
	});
});

test("replace: invalid regex throws a friendly message", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "(unclosed", replace: "x", regex: true }),
			/invalid regex/,
		);
	});
});

test("replace: invalid flag char throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "a", replace: "x", flags: "z" }),
			/invalid regex flag/,
		);
	});
});

test("replace: count-but-no-net-change does not rewrite and reports it", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "xx\n");
		// $& = whole match = "x", so the text is unchanged despite 2 matches
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "x", replace: "$&", regex: true });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "xx\n");
		assert.match(r.content[0].text, /no net change/);
	});
});

test("replace: returns details.diff (string) + patch + firstChangedLine", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B" });
		assert.equal(typeof r.details.diff, "string");
		assert.equal(typeof r.details.patch, "string");
		assert.equal(typeof r.details.firstChangedLine, "number");
	});
});

test("replace: returns fresh anchors for the changed region", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B" });
		const out: string = r.content[0].text;
		assert.match(out, /Updated anchors/);
		// line 2 now holds "B"; its anchor must be present and correct
		const a2 = anchorLine(out, 2);
		assert.match(a2, /^2#[0-9A-Z]{2,8}$/);
		assert.match(out, new RegExp(`^${a2}$`, "m"));
		assert.doesNotMatch(out, /│B/);
	});
});

test("replace: changed-region anchor chains a subsequent hashline edit without a re-read", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "old old old\n");
		const replace = makeReplaceTool(dir);
		const r1: any = await call(replace, { path: "f.txt", find: "old", replace: "new" });
		const out: string = r1.content[0].text;
		// line 1 is the changed line; chain an edit on its returned anchor
		const a1 = anchorLine(out, 1);
		const edit = makeEditOverride(dir);
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: a1, body: ["NEW NEW NEW"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "NEW NEW NEW\n");
	});
});

test("replace: multiline replacement (changes line count) still reports a correct span", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		// replace "b" with two lines → line count grows; changed region must cover the insertion
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B1\nB2" });
		assert.equal(await readFile(f, "utf-8"), "a\nB1\nB2\nc\n");
		const out: string = r.content[0].text;
		// the two inserted/changed lines (2 and 3) should both be anchored
		assert.doesNotThrow(() => anchorLine(out, 2));
		assert.doesNotThrow(() => anchorLine(out, 3));
	});
});

test("replace renderResult: renders the diff without throwing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const tool = makeReplaceTool(dir);
		const r: any = await call(tool, { path: "f.txt", find: "b", replace: "B" });
		// @ts-ignore — drive the renderer with a stub theme
		const comp: any = tool.renderResult(
			{ content: r.content, details: r.details },
			{ isPartial: false, expanded: true },
			stubTheme,
			{ isError: r.isError ?? false, state: {}, invalidate: () => {} },
		);
		assert.ok(typeof comp?.text === "string");
		assert.ok(comp.text.includes("B"), "rendered diff should contain the new content");
	});
});

test("replace renderResult: renders the error line without throwing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\n");
		const tool = makeReplaceTool(dir);
		let thrown: any;
		const r: any = await call(tool, { path: "f.txt", find: "zzz", replace: "y" }).catch((e: any) => {
			thrown = e;
			return null;
		});
		assert.ok(thrown, "expected the call to throw");
		// @ts-ignore — simulate how the framework hands the thrown message to renderResult
		const comp: any = tool.renderResult(
			{ content: [{ type: "text", text: thrown.message }] },
			{ isPartial: false, expanded: false },
			stubTheme,
			{ isError: true },
		);
		assert.ok(typeof comp?.text === "string");
	});
});

test("replace header: renderResult refreshes the call header in place — no invalidate", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const tool = makeReplaceTool(dir);
		const args = { path: "f.txt", find: "b", replace: "B1\nB2" };
		const r: any = await call(tool, args);
		let invalidated = false;
		const context: any = { args, isError: false, state: {}, invalidate: () => { invalidated = true; } };
		const header: any = tool.renderCall(args, stubTheme, context);
		assert.ok(!header.text.includes("+2"), "pre-execution header must not show counts");
		tool.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, context);
		assert.deepEqual(context.state.diffCounts, { added: 2, removed: 1 });
		assert.ok(header.text.includes("+2"), "header should show added count");
		assert.ok(header.text.includes("-1"), "header should show removed count");
		assert.ok(!invalidated, "renderResult must not call invalidate");
	});
});

test("replacement batches use one snapshot and return anchors for the final content", async () => withDir(async (dir) => {
	const file = join(dir, "batch.txt");
	const tool = makeReplaceTool(dir);
	const args = { path: file, replacements: [{ find: "foo", replace: "bar" }, { find: "bar", replace: "baz" }] };
	validateToolArguments(tool, { type: "toolCall", id: "0", name: "replace", arguments: args });
	await writeFile(file, "\uFEFFfoo\r\nbar\nfoo");
	const result = await call(tool, args);
	assert.equal(await readFile(file, "utf8"), "\uFEFFbar\r\nbaz\nbar");
	assert.match(result.content[0].text, /3 matches/);
	assert.match(result.details.diff, /^\+2 baz/m);
	await call(makeEditOverride(dir), { path: file, edits: [{ op: "replace", anchor: anchorLine(result.content[0].text, 2), body: ["chained"] }] });
	assert.equal(await readFile(file, "utf8"), "\uFEFFbar\r\nchained\nbar");
	assert.match(tool.renderCall(args, stubTheme, {}).text, /2 rules/);
}));

test("invalid batches reject every change and skip the fused command", async () => withDir(async (dir) => {
	const file = join(dir, "batch.txt");
	const before = "foo bar foo";
	await writeFile(file, before);
	let commands = 0;
	const tool = makeReplaceTool(dir, createActionFusionExecutor(async () => { commands++; return "done"; }));
	const first = { find: "bar", replace: "changed" };
	const cases = [
		{ replacements: [first, { find: "missing", replace: "x" }] },
		{ replacements: [first, { find: "foo", replace: "x", maxMatches: 1 }] },
		{ replacements: [first, { find: "(", replace: "x", regex: true }] },
		{ replacements: [first, { find: "bar foo", replace: "x" }] },
		{ replacements: [first, { find: "bar", replace: "x" }] },
		{ replacements: [first, { find: "foo", replace: "\0" }] },
		{ replacements: [first, { find: "foo", replace: "\ud800" }] },
		{ replacements: [first, { find: "foo", replace: "x", maxMatches: NaN }] },
		{ replacements: [first, { find: "foo", replace: "x", maxMatches: Infinity }] },
		{ replacements: [first, { find: "", replace: "x" }] },
		{ replacements: [first, { find: "foo" }] },
		{ replacements: [] },
		{ replacements: [first], find: "foo", replace: "x" },
		{ replacements: [first], flags: "i" },
		{},
	];
	for (const args of cases) {
		await assert.rejects(tool.execute("0", { path: file, ...args, then_run: { command: "check" } }, undefined, undefined, { cwd: dir }), /then_run:skipped/);
		assert.equal(await readFile(file, "utf8"), before);
	}
	assert.equal(commands, 0);
}));

test("adjacent matches and zero-width boundaries have deterministic batch semantics", async () => withDir(async (dir) => {
	const file = join(dir, "batch.txt");
	const tool = makeReplaceTool(dir);
	for (const rules of [
		[{ find: "a", replace: "b" }, { find: "b", replace: "a" }],
		[{ find: "b", replace: "a" }, { find: "a", replace: "b" }],
	]) {
		await writeFile(file, "ab");
		await call(tool, { path: file, replacements: rules });
		assert.equal(await readFile(file, "utf8"), "ba");
	}
	for (const find of ["^", "(?=b)", "$"]) {
		await writeFile(file, "ab");
		const args = { path: file, replacements: [{ find: "ab", replace: "X" }, { find, replace: "!", regex: true }] };
		if (find === "$") {
			await call(tool, args);
			assert.equal(await readFile(file, "utf8"), "X!");
		} else {
			await assert.rejects(call(tool, args), /overlap/);
			assert.equal(await readFile(file, "utf8"), "ab");
		}
	}
	await writeFile(file, "ab");
	await assert.rejects(call(tool, { path: file, replacements: [{ find: "^", replace: "x", regex: true }, { find: "(?=a)", replace: "y", regex: true }] }), /overlap/);
}));

test("regex templates agree with native replacement in single and snapshot batch modes", async () => withDir(async (dir) => {
	const file = join(dir, "regex.txt");
	const tool = makeReplaceTool(dir);
	const template = "$$|$&|$`|$'|$0|$00|$01|$1|$2|$10|$12|$99|$<x>|$<missing>|$<>|$<$&>|$<unclosed$1|$";
	for (const [source, find, flags] of [
		["ab b#", "(?<x>a)?b", "g"],
		["ab b#", "(a)?b", "g"],
		["ab#", "ab", "g"],
		["abcdefghijkl#", "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", "g"],
		["ab ab#", "(?<=a)(b)", "g"],
		["ab#", "(?=b)", "g"],
		["😀#", "(?=[^#])", "gu"],
		["aab#", "(a)", "gy"],
	]) {
		const rule = { find, replace: template, regex: true, flags };
		const expected = source.replace(new RegExp(find, flags), template);
		for (const batch of [false, true]) {
			await writeFile(file, source);
			// The second rule changes only the original final sentinel, not copies inserted by $' or $`.
			const args = batch ? { replacements: [rule, { find: "#$", replace: "!", regex: true }] } : rule;
			await call(tool, { path: file, ...args });
			assert.equal(await readFile(file, "utf8"), batch ? expected.slice(0, -1) + "!" : expected, `${find}/${flags}; batch=${batch}`);
		}
	}
}));

test("successful batches run one command against the complete result", async () => withDir(async (dir) => {
	const file = join(dir, "batch.txt");
	await writeFile(file, "foo bar");
	let commands = 0;
	const tool = makeReplaceTool(dir, createActionFusionExecutor(async () => {
		commands++;
		assert.equal(await readFile(file, "utf8"), "bar baz");
		return "checked";
	}));
	const result = await tool.execute("0", { path: file, replacements: [{ find: "foo", replace: "bar", maxMatches: 1 }, { find: "bar", replace: "baz", maxMatches: 1 }], then_run: { command: "check" } }, undefined, undefined, { cwd: dir });
	assert.equal(commands, 1);
	assert.equal(result.details.actionFusion.command, "succeeded");
	assert.match(result.content[0].text, /Updated anchors/);
}));

test("regex captures and zero-width insertions use logical offsets without consuming CRLF bytes", async () => withDir(async (dir) => {
	const path = join(dir, "f.txt");
	const before = "a\r\nb\rc\r\r\n";
	await writeFile(path, before);
	await call(makeReplaceTool(dir), { path, find: "(b\rc\r)\\n", replace: "$1\n", regex: true });
	assert.equal(await readFile(path, "utf8"), before);
	await call(makeReplaceTool(dir), { path, find: "(?=\\n)", replace: "!", regex: true });
	assert.equal(await readFile(path, "utf8"), "a!\r\nb\rc\r!\r\n");
}));

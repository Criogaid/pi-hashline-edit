/**
 * grep override execute tests: drive the real makeGrepOverride execute against
 * temp dirs — anchored content output, boolean combination (matchMode all /
 * excludePattern), output modes (files / count), wordMatch, multi-pattern any,
 * multi-path, context windows, ignoreCase, limit notice, and the disabled-mode
 * fallbacks (plain params delegate, extended params run un-anchored).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGrepOverride } from "./grep-tool.ts";
import { getState } from "./state.ts";
import { computeLineHash } from "../core/hash.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-grep-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

const A = "alpha beta\ngamma\nalpha only\nbeta only\nALPHA caps\n";
const B = "alpha here\nnothing\n";

async function seed(dir: string) {
	await writeFile(join(dir, "a.ts"), A);
	await writeFile(join(dir, "b.ts"), B);
}

const text = (r: any): string => r.content[0].text;

/** Run with hashline enabled/disabled, restoring the original config. */
async function withEnabled<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
	const state = getState();
	const prev = state.config.enabled;
	state.config.enabled = enabled;
	try {
		return await fn();
	} finally {
		state.config.enabled = prev;
	}
}

test("content: single pattern groups by file with LINE#HASH anchors", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha" });
		const out = text(r);
		assert.match(out, /a\.ts · 2 matches/);
		assert.match(out, /b\.ts · 1 match/);
		assert.match(out, /1#[0-9A-Z]+│alpha beta/);
		assert.match(out, /3#[0-9A-Z]+│alpha only/);
		assert.doesNotMatch(out, /gamma/);
	});
});

test("content: grep anchors match the hash computed from the full line", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha beta" });
		const hash = computeLineHash(1, "alpha beta");
		assert.match(text(r), new RegExp(`1#${hash}│alpha beta`));
	});
});

test("matchMode all: line must match every pattern (grep A | grep B)", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: ["alpha", "beta"], matchMode: "all" });
		const out = text(r);
		assert.match(out, /a\.ts · 1 match/);
		assert.match(out, /1#[0-9A-Z]+│alpha beta/);
		assert.doesNotMatch(out, /beta only/);
		assert.doesNotMatch(out, /alpha here/);
	});
});

test("excludePattern drops lines, like grep -v", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha", excludePattern: "beta" });
		const out = text(r);
		assert.match(out, /a\.ts · 1 match/);
		assert.match(out, /3#[0-9A-Z]+│alpha only/);
		assert.match(out, /b\.ts · 1 match/);
		assert.doesNotMatch(out, /alpha beta/);
	});
});

test("outputMode files: one path per line, no line content", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha", outputMode: "files" });
		assert.equal(text(r), "a.ts\nb.ts");
	});
});

test("outputMode count: per-file counts + total", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha", outputMode: "count" });
		assert.equal(text(r), "a.ts: 2\nb.ts: 1\nTotal: 3 matches in 2 files");
	});
});

test("wordMatch: whole words only", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "w.ts"), "foobar\nfoo bar\n");
		const r: any = await call(makeGrepOverride(dir), { pattern: "foo", wordMatch: true });
		const out = text(r);
		assert.match(out, /w\.ts · 1 match/);
		assert.match(out, /2#[0-9A-Z]+│foo bar/);
		assert.doesNotMatch(out, /foobar/);
	});
});

test("multi-pattern any (default): OR across patterns", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: ["gamma", "nothing"] });
		const out = text(r);
		assert.match(out, /a\.ts · 1 match/);
		assert.match(out, /2#[0-9A-Z]+│gamma/);
		assert.match(out, /b\.ts · 1 match/);
		assert.match(out, /2#[0-9A-Z]+│nothing/);
	});
});

test("path accepts an array of search roots", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "beta only", path: ["a.ts", "b.ts"] });
		const out = text(r);
		assert.match(out, /4#[0-9A-Z]+│beta only/);
		assert.match(out, /a\.ts · 1 match/);
	});
});

test("context: ±N lines around surviving matches, anchored", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "c.ts"), "l1\nl2\nl3\nl4\nl5\n");
		const r: any = await call(makeGrepOverride(dir), { pattern: "l3", context: 1 });
		const out = text(r);
		assert.match(out, /c\.ts · 1 match/);
		const rows = out.split("\n").filter((l) => /│l\d/.test(l));
		assert.deepEqual(
			rows.map((l) => l.replace(/#\w+│/, ":")),
			["2:l2", "3:l3", "4:l4"],
		);
	});
});

test("context windows are rebuilt from surviving matches (filtered match leaks no context)", async () => {
	await withDir(async (dir) => {
		// l4 is a match but excluded; it sits >ctx away from the surviving l1 match,
		// so none of its surroundings may appear as context
		await writeFile(join(dir, "c.ts"), "target keep\nl2\nl3\ndrop me\nl5\nl6\n");
		const r: any = await call(makeGrepOverride(dir), { pattern: "target|drop", excludePattern: "drop", context: 1 });
		const out = text(r);
		assert.match(out, /c\.ts · 1 match/);
		assert.match(out, /1#[0-9A-Z]+│target keep/);
		assert.match(out, /2#[0-9A-Z]+│l2/);
		assert.doesNotMatch(out, /l3/);
		assert.doesNotMatch(out, /drop me/);
		assert.doesNotMatch(out, /l5/);
	});
});

test("ignoreCase matches across case variants", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha", ignoreCase: true });
		assert.match(text(r), /a\.ts · 3 matches/);
		assert.match(text(r), /5#[0-9A-Z]+│ALPHA caps/);
	});
});

test("limit notice suggests doubling", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "a", limit: 2 });
		assert.match(text(r), /\[2 matches limit reached\. Use limit=4 for more, or refine pattern\]/);
	});
});

test("filters apply before the limit counts (a filtered match consumes no budget)", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		// a.ts:1 "alpha beta" is excluded; pre-filter counting would burn the whole
		// limit=1 budget on it and return nothing — post-filter counting yields a.ts:3
		const r: any = await call(makeGrepOverride(dir), { pattern: "alpha", excludePattern: "beta", limit: 1 });
		const out = text(r);
		assert.match(out, /3#[0-9A-Z]+│alpha only/);
		assert.match(out, /1 matches limit reached/);
	});
});

test("disabled + extended params: still runs, formatted without anchors", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		await withEnabled(false, async () => {
			const r: any = await call(makeGrepOverride(dir), { pattern: ["alpha", "beta"], matchMode: "all" });
			const out = text(r);
			assert.match(out, /a\.ts:1: alpha beta/);
			assert.doesNotMatch(out, /#[0-9A-Z]+│/);
			assert.doesNotMatch(out, /alpha here/);
		});
	});
});

test("disabled + plain params: delegates to the built-in grep", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		await withEnabled(false, async () => {
			const r: any = await call(makeGrepOverride(dir), { pattern: "alpha beta" });
			// built-in format: flat `path:line: content`, no group headers
			assert.match(text(r), /a\.ts:1: alpha beta/);
			assert.doesNotMatch(text(r), /· 1 match/);
		});
	});
});

test("CRLF files: display and filters are \r-clean, anchors hash the clean line", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "crlf.ts"), "alpha beta\r\ngamma\r\nalpha only\r\n");
		// anchors must hash the \r-stripped line — same splitLines as read/edit verify against
		const hash = computeLineHash(1, "alpha beta");
		const g: any = await call(makeGrepOverride(dir), { pattern: "alpha" });
		const out = text(g);
		assert.match(out, new RegExp(`1#${hash}│alpha beta`));
		assert.ok(!/[\r]/.test(out), "no carriage returns in output");
		// $-anchored filters must run on the cleaned text: "alpha beta\r" would dodge "beta$"
		const g2: any = await call(makeGrepOverride(dir), { pattern: "alpha", excludePattern: "beta$" });
		assert.match(text(g2), /alpha only/);
		assert.doesNotMatch(text(g2), /alpha beta/);
		// same for matchMode:"all" with a $-anchored pattern
		const g3: any = await call(makeGrepOverride(dir), { pattern: ["alpha", "only$"], matchMode: "all" });
		assert.match(text(g3), /3#[0-9A-Z]+│alpha only/);
		assert.doesNotMatch(text(g3), /alpha beta/);
	});
});

test("literal mode escapes regex metacharacters", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "d.ts"), "a.b\naxb\n");
		const r: any = await call(makeGrepOverride(dir), { pattern: "a.b", literal: true });
		const out = text(r);
		assert.match(out, /1#[0-9A-Z]+│a\.b/);
		assert.doesNotMatch(out, /axb/);
	});
});

test("no matches reports cleanly", async () => {
	await withDir(async (dir) => {
		await seed(dir);
		const r: any = await call(makeGrepOverride(dir), { pattern: "zzz" });
		assert.equal(text(r), "No matches found");
	});
});

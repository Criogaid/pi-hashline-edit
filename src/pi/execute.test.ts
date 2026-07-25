/**
 * pi integration execute tests: drive the real makeReadOverride/makeEditOverride
 * execute, covering text read with anchors, the hashline edit round-trip, and
 * error returns with isError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { clearSnapshots, getSnapshot } from "./state.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-"));
	clearSnapshots();
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
		clearSnapshots();
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

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

test("read execute: records snapshot for edit", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(join(dir, "f.txt"));
		assert.ok(snap, "snapshot not recorded");
		assert.equal(snap!.lineHashes.length, 2);
	});
});

test("edit execute: hashline round-trip (read → edit → file changed)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 2, hash: snap.lineHashes[1] }, body: ["B"] }],
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
	});
});

test("edit execute: multiple ops in one call", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [
				{ op: "insert_after", anchor: { line: 3, hash: snap.lineHashes[2] }, body: ["z"] },
				{ op: "replace", anchor: { line: 1, hash: snap.lineHashes[0] }, body: ["A"] },
			],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nb\nc\nz\n");
	});
});

test("edit execute: consecutive edits reuse updated snapshot", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		const read = makeReadOverride(dir);
		const edit = makeEditOverride(dir);
		await call(read, { path: "f.txt" });
		let snap = getSnapshot(f)!;
		await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 1, hash: snap.lineHashes[0] }, body: ["A"] }],
		});
		snap = getSnapshot(f)!;
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 2, hash: snap.lineHashes[1] }, body: ["B"] }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nB\n");
	});
});

test("edit execute: no read before edit → anchor verification fails", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 1, hash: "XXXX" }, body: ["A"] }],
		});
		assert.equal(r.isError, true);
	});
});

test("edit execute: empty edits → isError", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const r: any = await call(makeEditOverride(dir), { path: "f.txt", edits: [] });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /empty|missing/i);
	});
});

test("edit execute: malformed op (replace without body) → isError", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 1, hash: "XX" } }],
		});
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /body/i);
	});
});

test("edit execute: delete op", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "delete", anchor: { line: 2, hash: snap.lineHashes[1] } }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "a\nc\n");
	});
});

// --- renderer regression guards (P0: details.diff must be a string, renderResult must not throw) ---

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

test("edit success: details.diff is a string (not the generateDiffString object)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 2, hash: snap.lineHashes[1] }, body: ["B"] }],
		});
		assert.equal(typeof r.details.diff, "string", "details.diff must be a string");
		assert.equal(typeof r.details.patch, "string");
		assert.equal(typeof r.details.firstChangedLine, "number");
	});
});

test("edit success: renderResult renders the diff without throwing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 2, hash: snap.lineHashes[1] }, body: ["B"] }],
		});
		// @ts-ignore — drive the renderer with a stub theme
		const comp: any = edit.renderResult(r, { isPartial: false, expanded: true }, stubTheme);
		assert.ok(typeof comp?.text === "string");
		assert.ok(comp.text.includes("B"), "rendered diff should contain the new content");
	});
});

test("edit error: renderResult renders the error line without throwing", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 1, hash: "XXXX" }, body: ["A"] }],
		});
		assert.equal(r.isError, true);
		// @ts-ignore
		const comp: any = edit.renderResult(r, { isPartial: false, expanded: false }, stubTheme);
		assert.ok(typeof comp?.text === "string");
	});
});

test("hash length stays 4 even for runs of identical lines (no explosion)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "\n\n\n\ncode\n");
		const r: any = await call(makeReadOverride(dir), { path: "f.txt" });
		const text: string = r.content[0].text;
		// every "#HASH│" anchor in the output must use a 4-char hash
		for (const m of text.matchAll(/\d+#([0-9A-Z]+)│/g)) {
			assert.equal(m[1].length, 4, `anchor ${m[0]} hash is not 4 chars`);
		}
	});
});

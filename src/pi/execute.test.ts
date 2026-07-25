/**
 * Integration tests for the pi integration layer's execute: drives the real
 * makeReadOverride/makeEditOverride execute, covering text read with anchors,
 * the hashline edit closed loop, and error returns with isError.
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
		const read = makeReadOverride(dir);
		const r: any = await call(read, { path: "f.txt" });
		const text = r.content[0];
		assert.equal(text.type, "text");
		assert.match(text.text, /1#[0-9A-Z]+│line1/);
		assert.match(text.text, /2#[0-9A-Z]+│line2/);
		assert.match(text.text, /f\.txt · 2 lines/);
	});
});

test("read execute: records a snapshot for edit", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		const read = makeReadOverride(dir);
		await call(read, { path: "f.txt" });
		const snap = getSnapshot(join(dir, "f.txt"));
		assert.ok(snap, "snapshot not recorded");
		assert.equal(snap!.lineHashes.length, 2);
	});
});

test("edit execute: hashline closed loop (read → edit → file changed)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const snap = getSnapshot(f)!;
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			input: `replace 2#${snap.lineHashes[1]}:\n+B`,
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
	});
});

test("edit execute: consecutive edits reuse the updated snapshot", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		const read = makeReadOverride(dir);
		const edit = makeEditOverride(dir);
		await call(read, { path: "f.txt" });
		let snap = getSnapshot(f)!;
		await call(edit, { path: "f.txt", input: `replace 1#${snap.lineHashes[0]}:\n+A` });
		// second edit: the snapshot was updated by the edit, use the new hash
		snap = getSnapshot(f)!;
		const r: any = await call(edit, { path: "f.txt", input: `replace 2#${snap.lineHashes[1]}:\n+B` });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nB\n");
	});
});

test("edit execute: edit without a prior read → anchor verification fails", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		const edit = makeEditOverride(dir);
		// never read, so the hash is made up
		const r: any = await call(edit, { path: "f.txt", input: "replace 1#XXXX:\n+A" });
		assert.equal(r.isError, true);
	});
});

test("edit execute: missing input → isError + missing hint", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const r: any = await call(makeEditOverride(dir), { path: "f.txt" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /missing/);
	});
});

test("edit execute: legacy oldText/newText → isError + legacy hint", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /legacy/);
		assert.match(r.content[0].text, /ONLY/);
	});
});

test("edit execute: parse error → isError", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), { path: "f.txt", input: "SWAP 1#X:\n+a" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /Parse error|unknown verb/);
	});
});

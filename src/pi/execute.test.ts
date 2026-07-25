/**
 * pi 接入层 execute 集成测试：驱动真实的 makeReadOverride/makeEditOverride
 * execute，覆盖文本 read 带锚、hashline edit 闭环、错误返回 isError。
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

test("read execute：文本输出 LINE#HASH│content", async () => {
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

test("read execute：记录 snapshot 供 edit 用", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		const read = makeReadOverride(dir);
		await call(read, { path: "f.txt" });
		const snap = getSnapshot(join(dir, "f.txt"));
		assert.ok(snap, "snapshot 未记录");
		assert.equal(snap!.lineHashes.length, 2);
	});
});

test("edit execute：hashline 闭环（read → edit → 文件改）", async () => {
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
		assert.equal(r.isError, undefined, "不应是错误");
		assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
	});
});

test("edit execute：连续 edit 复用更新后的 snapshot", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		const read = makeReadOverride(dir);
		const edit = makeEditOverride(dir);
		await call(read, { path: "f.txt" });
		let snap = getSnapshot(f)!;
		await call(edit, { path: "f.txt", input: `replace 1#${snap.lineHashes[0]}:\n+A` });
		// 第二次 edit：snapshot 已被 edit 更新，用新 hash
		snap = getSnapshot(f)!;
		const r: any = await call(edit, { path: "f.txt", input: `replace 2#${snap.lineHashes[1]}:\n+B` });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nB\n");
	});
});

test("edit execute：无 read 直接 edit → anchor 校验失败", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		const edit = makeEditOverride(dir);
		// 没 read 过，hash 是瞎写的
		const r: any = await call(edit, { path: "f.txt", input: "replace 1#XXXX:\n+A" });
		assert.equal(r.isError, true);
	});
});

test("edit execute：缺 input → isError + missing 提示", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const r: any = await call(makeEditOverride(dir), { path: "f.txt" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /missing/);
	});
});

test("edit execute：旧 oldText/newText → isError + legacy 提示", async () => {
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

test("edit execute：parse 错误 → isError", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), { path: "f.txt", input: "SWAP 1#X:\n+a" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /Parse error|unknown verb/);
	});
});

import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, stat, symlink, link as createHardLink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { commitFile, FileMutationError, fileRevision } from "./file-commit.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteTool } from "./write-tool.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-commit-"));
	try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function isPermissionError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
}

async function holdWindowsExclusive(path: string): Promise<{ release: () => void; done: Promise<void> }> {
	const escaped = path.replaceAll("'", "''");
	const child = spawn("powershell.exe", ["-NoProfile", "-Command", `$stream = [IO.File]::Open('${escaped}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); Write-Output READY; [Console]::ReadLine(); $stream.Dispose()`], { stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("READY")) resolve(); });
		child.once("error", reject);
	});
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`exclusive holder exited with ${code}`)));
	});
	await ready;
	return { release: () => { child.stdin.write("release\n"); child.stdin.end(); }, done };
}

test("independent create commits race at the no-replace publication primitive", async () => withTemp(async (dir) => {
	const target = join(dir, "race.txt");
	const results = await Promise.allSettled([
		commitFile(target, "winner-a\n", { mode: "create" }),
		commitFile(target, "winner-b\n", { mode: "create" }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
	assert.ok(rejected.reason instanceof FileMutationError);
	assert.equal(rejected.reason.publication, "NOT_PUBLISHED");
	assert.match(await readFile(target, "utf8"), /^winner-[ab]\n$/);
}));

test("create never overwrites an existing target and expectedRevision remains strict", async () => withTemp(async (dir) => {
	const target = join(dir, "existing.txt");
	await writeFile(target, "original\n");
	const revision = await fileRevision(target);
	await assert.rejects(commitFile(target, "replacement\n", { mode: "create" }), (error: unknown) => error instanceof FileMutationError && error.publication === "NOT_PUBLISHED");
	await assert.rejects(commitFile(target, "replacement\n", { mode: "overwrite", expectedRevision: "stale" }), /expectedRevision/);
	assert.equal(await fileRevision(target), revision);
	assert.equal(await readFile(target, "utf8"), "original\n");
}));

test("replacement exposes complete old or new content during concurrent reads", async (t) => withTemp(async (dir) => {
	if (process.platform === "win32") return t.skip("Windows rename can reject a concurrently open reader; see platform matrix");
	const target = join(dir, "atomic.txt");
	const oldContent = "old-".repeat(200_000);
	const newContent = "new-".repeat(200_000);
	await writeFile(target, oldContent);
	let done = false;
	const commit = commitFile(target, newContent, { mode: "overwrite" }).finally(() => { done = true; });
	const observed = new Set<string>();
	while (!done) {
		const current = await readFile(target, "utf8");
		assert.ok(current === oldContent || current === newContent, "reader observed partial replacement content");
		observed.add(current === oldContent ? "old" : "new");
	}
	await commit;
	assert.ok(observed.size === 0 || [...observed].every((value) => value === "old" || value === "new"));
	assert.equal(await readFile(target, "utf8"), newContent);
}));

test("overwriting a symlink updates its resolved regular-file target and preserves the link", async (t) => withTemp(async (dir) => {
	const target = join(dir, "real.txt");
	const alias = join(dir, "alias.txt");
	await writeFile(target, "old\n");
	try { await symlink("real.txt", alias); } catch (error) { if (isPermissionError(error)) return t.skip("symlink creation unavailable"); throw error; }
	await commitFile(alias, "new\n", { mode: "overwrite" });
	assert.equal(await readFile(target, "utf8"), "new\n");
	assert.equal((await lstat(alias)).isSymbolicLink(), true);
	assert.equal(await readlink(alias), "real.txt");
}));

test("create rejects both valid and dangling symlinks without replacing the link", async (t) => withTemp(async (dir) => {
	const real = join(dir, "real.txt");
	const valid = join(dir, "valid.txt");
	const dangling = join(dir, "dangling.txt");
	await writeFile(real, "original\n");
	try {
		await symlink("real.txt", valid);
		await symlink("missing.txt", dangling);
	} catch (error) { if (isPermissionError(error)) return t.skip("symlink creation unavailable"); throw error; }
	await assert.rejects(commitFile(valid, "bad\n", { mode: "create" }), /already exists|symlink/);
	await assert.rejects(commitFile(dangling, "bad\n", { mode: "create" }), /symlink/);
	assert.equal((await lstat(valid)).isSymbolicLink(), true);
	assert.equal((await lstat(dangling)).isSymbolicLink(), true);
	assert.equal(await readFile(real, "utf8"), "original\n");
}));

test("replacement rejects a multi-hardlink target without changing either link", async (t) => withTemp(async (dir) => {
	const target = join(dir, "target.txt");
	const sibling = join(dir, "sibling.txt");
	await writeFile(target, "original\n");
	try { await createHardLink(target, sibling); } catch (error) { if (isPermissionError(error)) return t.skip("hardlink creation unavailable"); throw error; }
	await assert.rejects(commitFile(target, "bad\n", { mode: "overwrite" }), /multiple hard links/);
	assert.equal(await readFile(target, "utf8"), "original\n");
	assert.equal(await readFile(sibling, "utf8"), "original\n");
	assert.equal((await stat(target)).nlink, 2);
}));

test("existing private and executable permissions survive replacement; new files use private mode", async (t) => withTemp(async (dir) => {
	if (process.platform === "win32") return t.skip("Windows mode bits are not an ACL preservation test");
	const existing = join(dir, "existing.sh");
	await writeFile(existing, "old\n");
	await chmod(existing, 0o750);
	await commitFile(existing, "new\n", { mode: "overwrite" });
	assert.equal((await stat(existing)).mode & 0o777, 0o750);
	const created = join(dir, "created.txt");
	await commitFile(created, "new\n", { mode: "create" });
	assert.equal((await stat(created)).mode & 0o777, 0o600);
}));

test("directories are rejected instead of entering regular-file publication", async () => withTemp(async (dir) => {
	const target = join(dir, "directory");
	await mkdir(target);
	await assert.rejects(commitFile(target, "bad\n", { mode: "overwrite" }), /not a regular file/);
}));

test("Windows replacement failure never falls back to delete-then-write", async (t) => withTemp(async (dir) => {
	if (process.platform !== "win32") return t.skip("Windows-specific behavior");
	const target = join(dir, "readonly.txt");
	await writeFile(target, "original\n");
	await chmod(target, 0o444);
	try {
		await commitFile(target, "replacement\n", { mode: "overwrite" });
	} catch (error) {
		assert.ok(error instanceof FileMutationError);
		assert.ok(error.publication === "NOT_PUBLISHED" || error.publication === "UNKNOWN");
		assert.equal(await readFile(target, "utf8"), "original\n");
		return;
	}
	assert.equal(await readFile(target, "utf8"), "replacement\n");
}));

test("Windows shared access failure preserves the target, skips then_run, and releases the queue", async (t) => withTemp(async (dir) => {
	if (process.platform !== "win32") return t.skip("Windows shared-access behavior");
	const target = join(dir, "shared.txt");
	await writeFile(target, "original\n");
	const holder = await holdWindowsExclusive(target);
	let commandRuns = 0;
	const tool = makeWriteTool(dir, createActionFusionExecutor(async () => { commandRuns++; return "ok"; }));
	try {
		await assert.rejects(
			tool.execute("shared-failure", { path: target, content: "replacement\n", then_run: { command: "deterministic-command" } }, undefined, undefined, { cwd: dir }),
			(error: unknown) => error instanceof Error && /publication=(UNKNOWN|NOT_PUBLISHED)/.test(error.message) && /command=skipped/.test(error.message),
		);
		assert.equal(commandRuns, 0);
	} finally {
		holder.release();
		await holder.done;
	}
	let unlocked = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try { const probe = await open(target, "r"); await probe.close(); unlocked = true; break; } catch (error) {
			if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	assert.equal(unlocked, true, "Windows did not release the shared-access holder");
	assert.equal(await readFile(target, "utf8"), "original\n");
	const result = await tool.execute("shared-retry", { path: target, content: "replacement\n", then_run: { command: "deterministic-command" } }, undefined, undefined, { cwd: dir });
	assert.match(result.content.map((item: any) => item.type === "text" ? item.text : "").join("\n"), /then_run:succeeded/);
	assert.equal(commandRuns, 1);
	assert.equal(await readFile(target, "utf8"), "replacement\n");
	}));

test("cancellation racing publication never reports a settled operation as unpublished after success", async () => withTemp(async (dir) => {
	const target = join(dir, "cancel.txt");
	const oldContent = "old\n";
	const newContent = "new-".repeat(100_000);
	await writeFile(target, oldContent);
	const controller = new AbortController();
	const commit = commitFile(target, newContent, { mode: "overwrite", signal: controller.signal });
	setImmediate(() => controller.abort());
	try {
		const result = await commit;
		assert.equal(result.publication, "PUBLISHED");
	} catch (error) {
		assert.ok(error instanceof FileMutationError);
		assert.notEqual(error.publication, "PUBLISHED");
	}
	const finalContent = await readFile(target, "utf8");
	assert.ok(finalContent === oldContent || finalContent === newContent);
}));

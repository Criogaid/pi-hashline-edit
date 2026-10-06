import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  stat,
  symlink,
  link as createHardLink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  byteRevision,
  commitFile,
  commitReplacement,
  FileMutationError,
  fileRevision,
  readEditableSnapshot,
} from "./file-commit.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { callTool } from "./tool-call.testing.ts";

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hashline-commit-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
  );
}

async function holdWindowsExclusive(
  path: string,
): Promise<{ release: () => void; done: Promise<void> }> {
  const escaped = path.replaceAll("'", "''");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$stream = [IO.File]::Open('${escaped}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); Write-Output READY; [Console]::ReadLine(); $stream.Dispose()`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY")) resolve();
    });
    child.once("error", reject);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`exclusive holder exited with ${code}`)),
    );
  });
  await ready;
  return {
    release: () => {
      child.stdin.write("release\n");
      child.stdin.end();
    },
    done,
  };
}

test("independent create commits race at the no-replace publication primitive", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "race.txt");
    const results = await Promise.allSettled([
      commitFile(target, "winner-a\n", { mode: "create" }),
      commitFile(target, "winner-b\n", { mode: "create" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof FileMutationError);
    assert.equal(rejected.reason.publication, "NOT_PUBLISHED");
    assert.match(await readFile(target, "utf8"), /^winner-[ab]\n$/);
  }));

test("create never overwrites an existing target and expectedRevision remains strict", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "existing.txt");
    await writeFile(target, "original\n");
    const revision = await fileRevision(target);
    await assert.rejects(
      commitFile(target, "replacement\n", { mode: "create" }),
      (error: unknown) =>
        error instanceof FileMutationError && error.publication === "NOT_PUBLISHED",
    );
    await assert.rejects(
      commitFile(target, "replacement\n", { mode: "overwrite", expectedRevision: "stale" }),
      /expectedRevision/,
    );
    assert.equal(await fileRevision(target), revision);
    assert.equal(await readFile(target, "utf8"), "original\n");
  }));

test("replacement exposes complete old or new content during concurrent reads", async (t) =>
  withTemp(async (dir) => {
    if (process.platform === "win32")
      return t.skip("Windows rename can reject a concurrently open reader; see platform matrix");
    const target = join(dir, "atomic.txt");
    const oldContent = "old-".repeat(200_000);
    const newContent = "new-".repeat(200_000);
    await writeFile(target, oldContent);
    let done = false;
    const commit = commitFile(target, newContent, { mode: "overwrite" }).finally(() => {
      done = true;
    });
    while (!done) {
      const current = await readFile(target, "utf8");
      assert.ok(
        current === oldContent || current === newContent,
        "reader observed partial replacement content",
      );
    }
    await commit;
    assert.equal(await readFile(target, "utf8"), newContent);
  }));

test("overwriting a symlink updates its resolved regular-file target and preserves the link", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "real.txt");
    const alias = join(dir, "alias.txt");
    await writeFile(target, "old\n");
    try {
      await symlink("real.txt", alias);
    } catch (error) {
      if (isPermissionError(error)) return t.skip("symlink creation unavailable");
      throw error;
    }
    await commitFile(alias, "new\n", { mode: "overwrite" });
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(await readlink(alias), "real.txt");
  }));

test("create rejects both valid and dangling symlinks without replacing the link", async (t) =>
  withTemp(async (dir) => {
    const real = join(dir, "real.txt");
    const valid = join(dir, "valid.txt");
    const dangling = join(dir, "dangling.txt");
    await writeFile(real, "original\n");
    try {
      await symlink("real.txt", valid);
      await symlink("missing.txt", dangling);
    } catch (error) {
      if (isPermissionError(error)) return t.skip("symlink creation unavailable");
      throw error;
    }
    await assert.rejects(commitFile(valid, "bad\n", { mode: "create" }), /already exists|symlink/);
    await assert.rejects(commitFile(dangling, "bad\n", { mode: "create" }), /symlink/);
    assert.equal((await lstat(valid)).isSymbolicLink(), true);
    assert.equal((await lstat(dangling)).isSymbolicLink(), true);
    assert.equal(await readFile(real, "utf8"), "original\n");
  }));

test("replacement rejects a multi-hardlink target without changing either link", async (t) =>
  withTemp(async (dir) => {
    const target = join(dir, "target.txt");
    const sibling = join(dir, "sibling.txt");
    await writeFile(target, "original\n");
    try {
      await createHardLink(target, sibling);
    } catch (error) {
      if (isPermissionError(error)) return t.skip("hardlink creation unavailable");
      throw error;
    }
    await assert.rejects(commitFile(target, "bad\n", { mode: "overwrite" }), /multiple hard links/);
    assert.equal(await readFile(target, "utf8"), "original\n");
    assert.equal(await readFile(sibling, "utf8"), "original\n");
    assert.equal((await stat(target)).nlink, 2);
  }));

test("existing private and executable permissions survive replacement; new files use private mode", async (t) =>
  withTemp(async (dir) => {
    if (process.platform === "win32")
      return t.skip("Windows mode bits are not an ACL preservation test");
    const existing = join(dir, "existing.sh");
    await writeFile(existing, "old\n");
    await chmod(existing, 0o750);
    await commitFile(existing, "new\n", { mode: "overwrite" });
    assert.equal((await stat(existing)).mode & 0o777, 0o750);
    const created = join(dir, "created.txt");
    await commitFile(created, "new\n", { mode: "create" });
    assert.equal((await stat(created)).mode & 0o777, 0o600);
  }));

test("directories are rejected instead of entering regular-file publication", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "directory");
    await mkdir(target);
    await assert.rejects(commitFile(target, "bad\n", { mode: "overwrite" }), /not a regular file/);
  }));

test("Windows shared access failure preserves the target, skips then_run, and releases the queue", async (t) =>
  withTemp(async (dir) => {
    if (process.platform !== "win32") return t.skip("Windows shared-access behavior");
    const target = join(dir, "shared.txt");
    await writeFile(target, "original\n");
    const holder = await holdWindowsExclusive(target);
    let commandRuns = 0;
    const tool = makeWriteOverride(
      dir,
      createActionFusionExecutor(async () => {
        commandRuns++;
        return "ok";
      }),
    );
    try {
      await assert.rejects(
        callTool(
          tool,
          {
            path: target,
            content: "replacement\n",
            mode: "overwrite",
            then_run: { command: "deterministic-command" },
          },
          { toolCallId: "shared-failure", ctx: { cwd: dir } },
        ),
        (error: unknown) =>
          error instanceof Error &&
          /File state is uncertain|No file changes were published/.test(error.message) &&
          /Command skipped/.test(error.message),
      );
      assert.equal(commandRuns, 0);
    } finally {
      holder.release();
      await holder.done;
    }
    let unlocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const probe = await open(target, "r");
        await probe.close();
        unlocked = true;
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "EBUSY"
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(unlocked, true, "Windows did not release the shared-access holder");
    assert.equal(await readFile(target, "utf8"), "original\n");
    const result = await callTool(
      tool,
      {
        path: target,
        content: "replacement\n",
        mode: "overwrite",
        then_run: { command: "deterministic-command" },
      },
      { toolCallId: "shared-retry", ctx: { cwd: dir } },
    );
    assert.match(
      result.content.map((item: any) => (item.type === "text" ? item.text : "")).join("\n"),
      /then_run:succeeded/,
    );
    assert.equal(commandRuns, 1);
    assert.equal(await readFile(target, "utf8"), "replacement\n");
  }));

test("cancellation racing publication never reports a settled operation as unpublished after success", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "cancel.txt");
    const oldContent = "old\n";
    const newContent = "new-".repeat(100_000);
    await writeFile(target, oldContent);
    const controller = new AbortController();
    const commit = commitFile(target, newContent, { mode: "overwrite", signal: controller.signal });
    setImmediate(() => controller.abort());
    let publication: "NOT_PUBLISHED" | "PUBLISHED" | "UNKNOWN";
    try {
      const result = await commit;
      publication = result.publication;
      assert.equal(publication, "PUBLISHED");
    } catch (error) {
      assert.ok(error instanceof FileMutationError);
      publication = error.publication;
    }
    const finalContent = await readFile(target, "utf8");
    assert.ok(finalContent === oldContent || finalContent === newContent);
    if (publication === "NOT_PUBLISHED") assert.equal(finalContent, oldContent);
    if (publication === "PUBLISHED") assert.equal(finalContent, newContent);
  }));

test("commit result binds base, published, and observed revisions", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "versions.txt");
    await writeFile(target, "before\n");
    const baseRevision = await fileRevision(target);
    const result = await commitFile(target, "after\n", {
      mode: "overwrite",
      expectedRevision: baseRevision,
    });
    assert.equal(result.baseRevision, baseRevision);
    assert.equal(result.publishedRevision, byteRevision("after\n"));
    assert.equal(result.observedRevision, result.publishedRevision);
    assert.equal("revision" in result, false);
  }));

test("commit rejects lossy UTF-8 output before modifying or creating files", async () =>
  withTemp(async (dir) => {
    const existing = join(dir, "existing.txt");
    const missing = join(dir, "missing.txt");
    await writeFile(existing, "original\n");
    for (const content of ["\ud800", "\udfff", "before\ud800after"]) {
      for (const path of [existing, missing]) {
        await assert.rejects(
          commitFile(path, content, { mode: path === existing ? "overwrite" : "create" }),
          (error: any) =>
            error.publication === "NOT_PUBLISHED" && /INVALID_UNICODE/.test(error.message),
        );
      }
    }
    assert.equal(await readFile(existing, "utf8"), "original\n");
    await assert.rejects(readFile(missing), { code: "ENOENT" });
    const content = "\uFEFFvalid 😀\r\n";
    const result = await commitFile(existing, content, { mode: "overwrite" });
    assert.deepEqual(await readFile(existing), Buffer.from(content));
    assert.equal(result.publishedRevision, byteRevision(Buffer.from(content)));
  }));

test("identical commits preserve the file and still enforce mode, revision, and cancellation", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "same.txt");
    const content = "\uFEFFsame\r\nbytes\n";
    await writeFile(target, content);
    const before = await stat(target);
    const revision = await fileRevision(target);
    const result = await commitFile(target, content, {
      mode: "overwrite",
      expectedRevision: revision,
    });
    assert.deepEqual(result, {
      created: false,
      baseRevision: revision,
      publishedRevision: revision,
      observedRevision: revision,
      publication: "NOT_PUBLISHED",
    });
    const after = await stat(target);
    assert.deepEqual(
      [after.ino, after.mtimeMs, after.ctimeMs],
      [before.ino, before.mtimeMs, before.ctimeMs],
    );
    await assert.rejects(commitFile(target, content, { mode: "create" }), /already exists/);
    await assert.rejects(
      commitFile(target, content, { mode: "overwrite", expectedRevision: "stale" }),
      /expectedRevision/,
    );
    await assert.rejects(
      commitFile(target, content, { mode: "overwrite", signal: AbortSignal.abort() }),
      (error: unknown) =>
        error instanceof FileMutationError && error.publication === "NOT_PUBLISHED",
    );
    await assert.rejects(
      commitFile(join(dir, "missing"), "", { mode: "overwrite" }),
      /does not exist/,
    );
    const created = await commitFile(join(dir, "empty"), "", { mode: "create" });
    assert.equal(created.created, true);
    assert.equal(created.publication, "PUBLISHED");
  }));

test("no-op commit with knownBeforeRevision validates disk revision against external modifications", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "target.txt");
    const initialContent = "line 1\nline 2\n";
    await writeFile(target, initialContent);
    const snapshot = await readEditableSnapshot(target, "target.txt");
    assert.equal(snapshot.text, initialContent);

    // External process modifies target after snapshot is read.
    await writeFile(target, "line 1\nmodified line 2\n");
    const externalRevision = await fileRevision(target);

    // A no-op replacement (same text as snapshot) must reject because disk has changed.
    await assert.rejects(
      commitReplacement(target, "target.txt", snapshot.text, snapshot.baseRevision),
      (error: unknown) =>
        error instanceof FileMutationError &&
        error.stage === "prepare" &&
        error.publication === "NOT_PUBLISHED" &&
        /expectedRevision/.test(error.message),
    );
    // Disk content must remain untouched by the rejected commit.
    assert.equal(await readFile(target, "utf8"), "line 1\nmodified line 2\n");
    assert.equal(await fileRevision(target), externalRevision);

    // Direct commitFile with knownBeforeRevision and matching expectedRevision also rejects.
    await assert.rejects(
      commitFile(target, snapshot.text, {
        mode: "overwrite",
        expectedRevision: snapshot.baseRevision,
        knownBeforeRevision: snapshot.baseRevision,
      }),
      (error: unknown) =>
        error instanceof FileMutationError &&
        error.stage === "prepare" &&
        error.publication === "NOT_PUBLISHED" &&
        /expectedRevision/.test(error.message),
    );

    // Without expectedRevision, commitFile recognizes disk has changed and publishes the content.
    const overwriteResult = await commitFile(target, snapshot.text, {
      mode: "overwrite",
      knownBeforeRevision: snapshot.baseRevision,
    });
    assert.equal(overwriteResult.publication, "PUBLISHED");
    assert.equal(await readFile(target, "utf8"), initialContent);

    // When target does not change externally, no-op commit succeeds and confirms observed revision.
    const freshSnapshot = await readEditableSnapshot(target, "target.txt");
    const noopResult = await commitReplacement(
      target,
      "target.txt",
      freshSnapshot.text,
      freshSnapshot.baseRevision,
    );
    assert.equal(noopResult.publication, "NOT_PUBLISHED");
    assert.equal(noopResult.baseRevision, freshSnapshot.baseRevision);
    assert.equal(noopResult.publishedRevision, freshSnapshot.baseRevision);
    assert.equal(noopResult.observedRevision, freshSnapshot.baseRevision);
  }));

test("no-op commit with knownBeforeRevision rejects if target was deleted externally", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "deleted.txt");
    await writeFile(target, "content\n");
    const snapshot = await readEditableSnapshot(target, "deleted.txt");

    await rm(target);

    await assert.rejects(
      commitReplacement(target, "deleted.txt", snapshot.text, snapshot.baseRevision),
      (error: unknown) =>
        error instanceof FileMutationError &&
        error.stage === "prepare" &&
        error.publication === "NOT_PUBLISHED",
    );
  }));

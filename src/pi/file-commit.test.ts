import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  commitFile,
  FileMutationError,
  readEditableSnapshot,
  type CommitResult,
  type FreshnessObservation,
} from "./file-commit.ts";
import { byteRevision } from "./file-revision.ts";
import { HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { describeMutationFailure } from "./mutation-result.ts";
import { reportOf } from "./report.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";

// Checked by tsc; these states cannot be returned by the commit layer.
function invalidCommitStates() {
  // @ts-expect-error A newly created target is always published.
  const unpublishedCreate: CommitResult = {
    created: true,
    publication: "NOT_PUBLISHED",
    publishedRevision: "r",
    observedRevision: "r",
  };
  // @ts-expect-error A no-op has a confirmed observed revision.
  const unobservedNoop: CommitResult = {
    created: false,
    publication: "NOT_PUBLISHED",
    publishedRevision: "r",
  };
  // @ts-expect-error A known freshness state cannot carry a read error.
  const knownError: FreshnessObservation = {
    freshness: "changed",
    error: new Error("read failed"),
  };
  // @ts-expect-error Unknown freshness records the error that prevented observation.
  const unexplainedUnknown: FreshnessObservation = { freshness: "unknown" };
}

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
    assert.ok(rejected.reason instanceof HashlineError);
    assert.equal(rejected.reason.errorCode, "TARGET_EXISTS");
    assert.match(await readFile(target, "utf8"), /^winner-[ab]\n$/);
  }));

test("create never overwrites an existing target", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "existing.txt");
    await writeFile(target, "original\n");
    const revision = byteRevision(await readFile(target));
    await assert.rejects(
      commitFile(target, "replacement\n", { mode: "create" }),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "TARGET_EXISTS",
    );
    assert.equal(byteRevision(await readFile(target)), revision);
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

test("files are replaced or created → preserve existing modes and apply umask to new files", async (t) =>
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
    assert.equal((await stat(created)).mode & 0o777, 0o666 & ~process.umask());
  }));

test("directories are rejected instead of entering regular-file publication", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "directory");
    await mkdir(target);
    await assert.rejects(commitFile(target, "bad\n", { mode: "overwrite" }), (error: unknown) => {
      assert.ok(error instanceof HashlineError);
      assert.equal(error.errorCode, "NOT_REGULAR_FILE");
      assert.equal(error.message, PATH_ERROR_MESSAGES.NOT_REGULAR_FILE);
      return true;
    });
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
        return { status: "succeeded", result: { content: [{ type: "text", text: "ok" }] } };
      }),
    );
    try {
      const failed = await callTool(
        tool,
        {
          path: target,
          content: "replacement\n",
          mode: "overwrite",
          then_run: { command: "deterministic-command" },
        },
        { toolCallId: "shared-failure", ctx: { cwd: dir } },
      );
      assert.equal(failed.isError, true);
      const report = reportOf(failed, "write");
      assert.ok(report);
      assert.ok(report.publication === "NOT_PUBLISHED" || report.publication === "UNKNOWN");
      assert.equal(report.then_run?.status, "skipped");
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
    assert.equal(result.isError, undefined);
    assert.equal(reportOf(result, "write")?.then_run?.status, "succeeded");
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
      assert.ok(error instanceof HashlineError);
      if (!(error instanceof FileMutationError)) assert.equal(error.errorCode, "OPERATION_ABORTED");
      const reported = describeMutationFailure("write", error, {
        budget: DEFAULT_OUTPUT_BUDGETS,
      }).publication;
      assert.ok(reported);
      publication = reported;
    }
    const finalContent = await readFile(target, "utf8");
    assert.ok(finalContent === oldContent || finalContent === newContent);
    if (publication === "NOT_PUBLISHED") assert.equal(finalContent, oldContent);
    if (publication === "PUBLISHED") assert.equal(finalContent, newContent);
  }));

test("bound overwrite → reports published and observed revisions for the published bytes", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "versions.txt");
    await writeFile(target, "before\n");
    const baseRevision = byteRevision(await readFile(target));
    const result = await commitFile(target, "after\n", {
      mode: "overwrite",
      baseRevision,
    });
    assert.equal(result.publication, "PUBLISHED");
    assert.equal(await readFile(target, "utf8"), "after\n");
    assert.equal(result.publishedRevision, byteRevision(Buffer.from("after\n")));
    assert.equal(result.observedRevision, result.publishedRevision);
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
          (error: unknown) =>
            error instanceof HashlineError && error.errorCode === "INVALID_UNICODE",
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
    const revision = byteRevision(await readFile(target));
    const result = await commitFile(target, content, {
      mode: "overwrite",
      baseRevision: revision,
    });
    assert.deepEqual(result, {
      created: false,
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
      commitFile(target, content, { mode: "overwrite", baseRevision: "stale" }),
      (error: unknown) =>
        error instanceof HashlineError &&
        error.errorCode === "FILE_CHANGED" &&
        error.message === "File changed after it was read.",
    );
    await assert.rejects(
      commitFile(target, content, { mode: "overwrite", signal: AbortSignal.abort() }),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED",
    );
    const missing = join(dir, "missing");
    await assert.rejects(commitFile(missing, "", { mode: "overwrite" }), (error: unknown) => {
      assert.ok(error instanceof HashlineError);
      assert.equal(error.errorCode, "PATH_NOT_FOUND");
      assert.equal(error.message, PATH_ERROR_MESSAGES.PATH_NOT_FOUND);
      assert.deepEqual(error.facts, { missing: [missing] });
      assert.equal(error.next, "useCreate");
      return true;
    });
    const created = await commitFile(join(dir, "empty"), "", { mode: "create" });
    assert.equal(created.created, true);
    assert.equal(created.publication, "PUBLISHED");
  }));

test("file changes after the read → bound commits reject changed and unchanged output", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "target.txt");
    const initialContent = "line 1\nline 2\n";
    await writeFile(target, initialContent);
    const snapshot = await readEditableSnapshot(target);
    assert.equal(snapshot.text, initialContent);

    // External process modifies target after snapshot is read.
    await writeFile(target, "line 1\nmodified line 2\n");
    const externalRevision = byteRevision(await readFile(target));

    for (const content of [snapshot.text, "replacement\n"]) {
      await assert.rejects(
        () =>
          commitFile(target, content, { mode: "overwrite", baseRevision: snapshot.baseRevision }),
        (error: unknown) => error instanceof HashlineError && error.errorCode === "FILE_CHANGED",
      );
      assert.equal(await readFile(target, "utf8"), "line 1\nmodified line 2\n");
      assert.equal(byteRevision(await readFile(target)), externalRevision);
    }

    // Without baseRevision, overwrite hashes the current target instead of using the snapshot.
    const overwriteResult = await commitFile(target, snapshot.text, {
      mode: "overwrite",
    });
    assert.equal(overwriteResult.publication, "PUBLISHED");
    assert.equal(overwriteResult.publishedRevision, snapshot.baseRevision);
    assert.equal(overwriteResult.observedRevision, overwriteResult.publishedRevision);
    assert.equal(await readFile(target, "utf8"), initialContent);

    // When target does not change externally, no-op commit succeeds and confirms observed revision.
    const freshSnapshot = await readEditableSnapshot(target);
    const noopResult = await commitFile(target, freshSnapshot.text, {
      mode: "overwrite",
      baseRevision: freshSnapshot.baseRevision,
    });
    assert.equal(noopResult.publication, "NOT_PUBLISHED");
    assert.equal(noopResult.publishedRevision, freshSnapshot.baseRevision);
    assert.equal(noopResult.observedRevision, freshSnapshot.baseRevision);
  }));

test("no-op commit with baseRevision rejects if target was deleted externally", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "deleted.txt");
    await writeFile(target, "content\n");
    const snapshot = await readEditableSnapshot(target);

    await rm(target);

    await assert.rejects(
      commitFile(target, snapshot.text, {
        mode: "overwrite",
        baseRevision: snapshot.baseRevision,
      }),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "PATH_NOT_FOUND",
    );
  }));

test("commitFile temporary publication → handles existing and missing parents and preserves other failures", async (t) =>
  withTemp(async (dir) => {
    const originalMkdir = fsPromises.mkdir;
    const originalMkdtemp = fsPromises.mkdtemp;
    for (const scenario of ["existing", "nested", "denied"] as const) {
      const parent = scenario === "nested" ? join(dir, "new", "nested") : dir;
      const target = join(parent, `${scenario}.txt`);
      let mkdirCalls = 0;
      const denied = Object.assign(new Error("denied"), { code: "EPERM" });
      try {
        t.mock.method(fsPromises, "mkdir", async (...args: Parameters<typeof originalMkdir>) => {
          mkdirCalls++;
          if (scenario !== "nested") throw denied;
          return originalMkdir(...args);
        });
        t.mock.method(
          fsPromises,
          "mkdtemp",
          async (...args: Parameters<typeof originalMkdtemp>) => {
            if (scenario === "denied") throw denied;
            return originalMkdtemp(...args);
          },
        );
        syncBuiltinESMExports();
        if (scenario === "denied") {
          await assert.rejects(
            commitFile(target, "data", { mode: "create" }),
            (error: unknown) =>
              error instanceof HashlineError &&
              error.errorCode === "PUBLISH_FAILED" &&
              error.cause === denied,
          );
          await assert.rejects(readFile(target), { code: "ENOENT" });
        } else {
          const result = await commitFile(target, "data", { mode: "create" });
          assert.equal(result.publication, "PUBLISHED");
          assert.equal(await readFile(target, "utf8"), "data");
        }
        assert.equal(mkdirCalls, scenario === "nested" ? 1 : 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    }
  }));

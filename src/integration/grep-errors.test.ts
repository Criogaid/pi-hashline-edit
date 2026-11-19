import { listCandidates } from "../pi/grep-candidates.ts";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { DEFAULT_CONFIG, makeGrepOverride } = await import("../pi/tool-factories.testing.ts");

import { callTool } from "../pi/tool-call.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

for (const condition of ["permission denied", "symlink loop"] as const) {
  test(`existing search path has ${condition} → grep retains the real filesystem error`, {
    skip:
      process.platform === "win32" ||
      (condition === "permission denied" && process.getuid?.() === 0)
        ? "Requires POSIX traversal permissions and symlinks; permission case requires a non-root user"
        : false,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hashline-grep-scope-"));
    const denied = join(directory, "denied");
    t.after(async () => {
      if (condition === "permission denied") await chmod(denied, 0o700);
      await rm(directory, { recursive: true, force: true });
    });
    let path: string;
    let code: string;
    if (condition === "permission denied") {
      await mkdir(denied);
      path = join(denied, "source.txt");
      await writeFile(path, "needle中文\n");
      await chmod(denied, 0);
      code = "EACCES";
    } else {
      path = join(directory, "loop");
      await symlink("loop", path);
      code = "ELOOP";
    }
    await assert.rejects(stat(path), { code });
    const tool = makeGrepOverride(directory, DEFAULT_CONFIG);
    await expectToolFailure(
      callTool(tool, { path, pattern: "needle", literal: true, ignoreCase: false }),
      "FILESYSTEM_ERROR",
      (report) => {
        assert.doesNotMatch(report.message ?? "", /Path not found/);
        assert.ok(report.message?.includes(code));
        assert.equal(report.cause, undefined);
      },
    );
  });
}

test("dangling link with no prefilter matches → do not offer unfiltered candidates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-grep-dangling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "nonmatch.txt"), "other text\n");
  await symlink(
    join(directory, "missing"),
    join(directory, "dangling"),
    process.platform === "win32" ? "junction" : "file",
  );

  const offered: string[] = [];
  const { listing } = await listCandidates({
    scope: { searchPaths: [directory], globs: [] },
    query: { patterns: ["needle"], literal: true, ignoreCase: false, multiline: true },
    signal: new AbortController().signal,
    stopped: () => false,
    onCandidate: async ({ filePath }) => {
      offered.push(filePath);
      return true;
    },
  });
  assert.deepEqual(offered, []);
  assert.equal(listing?.code, 2);
  assert.match(listing.stderr, /dangling/);
});

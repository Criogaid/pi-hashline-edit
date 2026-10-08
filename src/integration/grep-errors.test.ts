import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { callTool } from "../pi/tool-call.testing.ts";

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
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    await assert.rejects(
      callTool(tool, { path, pattern: "needle", literal: true, ignoreCase: false }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /Path not found/);
        assert.ok("code" in error);
        assert.equal(error.code, code);
        return true;
      },
    );
  });
}

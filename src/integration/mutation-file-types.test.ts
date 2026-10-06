import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

test("FIFO mutation targets → reject without waiting for a writer, including through a symlink", {
  skip: process.platform === "win32" ? "POSIX FIFO behavior" : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-fifo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = join(directory, "pipe");
  await execFile("mkfifo", [fifo]);
  await symlink("pipe", join(directory, "alias"));
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // Isolate a blocking open so a regression cannot leave the test runner's I/O threads stuck.
  const script = `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import { makeEditOverride } from ${moduleUrl("../pi/edit-tool.ts")};
    import { makeReplaceTool } from ${moduleUrl("../pi/replace-tool.ts")};
    import { DEFAULT_CONFIG } from ${moduleUrl("../pi/config.ts")};
    import { callTool } from ${moduleUrl("../pi/tool-call.testing.ts")};
    const directory = process.argv[1];
    const cases = [
      [makeEditOverride(directory, DEFAULT_CONFIG), { edits: [{ op: "append", body: ["after"] }] }],
      [makeReplaceTool(directory, DEFAULT_CONFIG), { replacements: [{ find: "before", replace: "after" }] }],
    ];
    for (const path of ["pipe", "alias"]) {
      for (const [tool, args] of cases) {
        await assert.rejects(callTool(tool, { path: join(directory, path), ...args }),
          error => /not a regular file/.test(error.message) && error.publication === "NOT_PUBLISHED");
      }
    }
  `;
  await execFile(process.execPath, ["--input-type=module", "--eval", script, directory], {
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
});

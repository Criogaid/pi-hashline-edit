import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "../testing/process.testing.ts";

const execFile = promisify(execFileCallback);

test("FIFO mutation targets → reject without waiting for a writer, including through a symlink", {
  skip: process.platform === "win32" ? "POSIX FIFO behavior" : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-fifo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = join(directory, "pipe");
  await execFile("mkfifo", [fifo]);
  await symlink("pipe", join(directory, "alias"));
  // Isolate a blocking open so a regression cannot leave the parent runner stuck.
  await execFile(
    process.execPath,
    [fileURLToPath(new URL("./mutation-file-types.testing.ts", import.meta.url)), directory],
    {
      env: testEnvironment(directory),
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
});

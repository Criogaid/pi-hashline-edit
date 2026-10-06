import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMutationError, readEditableSnapshot } from "./file-commit.ts";

test("snapshot cancelled while opening → rejects as an unpublished cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "file.txt");
  await writeFile(path, "before\n");
  const controller = new AbortController();
  const reading = readEditableSnapshot(path, "file.txt", controller.signal);
  controller.abort();
  await assert.rejects(
    reading,
    (error: unknown) =>
      error instanceof FileMutationError &&
      error.publication === "NOT_PUBLISHED" &&
      error.message.startsWith("Operation aborted"),
  );
  assert.equal(await readFile(path, "utf8"), "before\n");
});

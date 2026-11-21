import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HashlineError } from "../core/errors.ts";
import { readEditableSnapshot } from "./file-read.ts";
import { byteRevision } from "./file-revision.ts";

test("snapshot cancelled while opening → rejects as an unpublished cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "file.txt");
  await writeFile(path, "before\n");
  const controller = new AbortController();
  const reading = readEditableSnapshot(path, controller.signal);
  controller.abort();
  await assert.rejects(
    reading,
    (error: unknown) => error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED",
  );
  assert.equal(await readFile(path, "utf8"), "before\n");
});

for (const [kind, padding] of [
  ["small", 0],
  ["multi-chunk", 64 * 1024 - 4],
] as const) {
  test(`${kind} editable snapshot → preserves the original UTF-8 bytes and binds their revision`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hashline-snapshot-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "file.txt");
    const original = Buffer.from("\uFEFF" + "x".repeat(padding) + "中\r\nlast\r");
    await writeFile(path, original);
    const snapshot = await readEditableSnapshot(path, new AbortController().signal);
    assert.deepEqual(Buffer.from(snapshot.text, "utf8"), original);
    assert.equal(snapshot.baseRevision, byteRevision(original));
  });
}

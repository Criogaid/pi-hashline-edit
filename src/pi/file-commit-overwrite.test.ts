import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileRead } from "./file-read.ts";
import * as revision from "./file-revision.ts";

test("target changes while hashing identical overwrite content → publishes requested bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "target.txt");
  const content = "A";
  await writeFile(target, content);

  // An identical overwrite hashes the same bytes for the target and the request.
  // Track the buffers that came from disk so only the request hash triggers the other write.
  const targetReads = new WeakSet<Uint8Array>();
  const trackFileRead: typeof withFileRead = async (path, signal, read) => {
    const result = await withFileRead(path, signal, read);
    if (result instanceof Uint8Array) targetReads.add(result);
    return result;
  };
  t.mock.module("./file-read.ts", { namedExports: { withFileRead: trackFileRead } });
  t.mock.module("./file-revision.ts", {
    namedExports: {
      ...revision,
      byteRevision(bytes: Uint8Array) {
        if (!targetReads.has(bytes)) writeFileSync(target, "B");
        return revision.byteRevision(bytes);
      },
    },
  });
  const { commitFile } = await import("./file-commit.ts");
  const { publication, freshness } = await commitFile(
    target,
    content,
    { mode: "overwrite" },
    new AbortController().signal,
  );
  assert.deepEqual(
    { publication, freshness, bytes: await readFile(target) },
    { publication: "PUBLISHED", freshness: "unchanged", bytes: Buffer.from(content) },
  );
});

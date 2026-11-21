import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as revision from "./file-revision.ts";

test("target changes while hashing identical overwrite content → publishes requested bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "target.txt");
  const content = "A";
  await writeFile(target, content);

  // Simulate a concurrent writer while hashing the request bytes.
  t.mock.module("./file-revision.ts", {
    namedExports: {
      ...revision,
      byteRevision(bytes: Uint8Array) {
        writeFileSync(target, "B");
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

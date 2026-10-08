import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileRead } from "./file-read.ts";

for (const replacement of ["", "汉字\n"]) {
  test(`${replacement ? "same-size rewrite" : "truncation"} during a whole-file read → rejects the unstable snapshot`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hashline-file-read-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "source.txt");
    await writeFile(path, "中文\n");
    await utimes(path, new Date(0), new Date(0));
    await assert.rejects(
      withFileRead(path, undefined, async (handle) => {
        const bytes = await handle.readFile();
        await writeFile(path, replacement);
        return bytes;
      }),
      /File changed/,
    );
    assert.equal(await readFile(path, "utf8"), replacement);
    assert.equal(
      (await withFileRead(path, undefined, (handle) => handle.readFile())).toString("utf8"),
      replacement,
    );
  });
}

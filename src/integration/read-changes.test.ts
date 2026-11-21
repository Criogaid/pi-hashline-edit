import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/tool-factories.testing.ts";
import { makeGrepOverride } from "../pi/tool-factories.testing.ts";
import { makeReadOverride } from "../pi/tool-factories.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { readFileRevision } from "../pi/file-read.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { byteRevision } from "../pi/file-revision.ts";
import { scanTextFile } from "../pi/text-stream.ts";

const CHUNK_BYTES = 64 * 1024;

test("read or grep scan truncated across a UTF-8 sequence → reports file change without encoding blame", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-read-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "race.txt");
  const source = Buffer.from(
    "head\r\n" +
      "x".repeat(CHUNK_BYTES - 7) +
      "中" +
      "x".repeat(CHUNK_BYTES - 3) +
      "中" +
      "tail".repeat(CHUNK_BYTES),
  );
  assert.equal(isUtf8(source), true);
  const tools = [
    makeReadOverride(directory, DEFAULT_CONFIG),
    makeGrepOverride(directory, DEFAULT_CONFIG),
  ];
  for (const tool of tools) {
    await t.test(tool.name, async (t) => {
      await writeFile(path, source);
      const original = fs.createReadStream;
      let scans = 0;
      t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
        const stream = original(...args);
        if (args[0] === path && ++scans === (tool.name === "read" ? 1 : 2)) {
          stream.once("data", () => fs.truncateSync(path, CHUNK_BYTES - 1));
        }
        return stream;
      });
      syncBuiltinESMExports();
      try {
        const args =
          tool.name === "read" ? { path, limit: 1 } : { path, pattern: "head", literal: true };
        await expectToolFailure(
          callTool(tool, args),
          tool.name === "read" ? "FILE_CHANGED" : "SEARCH_INCOMPLETE",
          (report) => {
            if (tool.name === "grep") {
              assert.match(report.diagnostics ?? "", /race\.txt/);
              assert.match(report.diagnostics ?? "", /File changed during read\./);
            } else assert.match(JSON.stringify(report), /File changed/);
            assert.doesNotMatch(JSON.stringify(report), /UNSUPPORTED_ENCODING|Invalid UTF-8/);
          },
        );
        const current = await readFile(path);
        assert.equal(isUtf8(current), true);
        assert.deepEqual(current, source.subarray(0, CHUNK_BYTES - 1));
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});

for (const operation of ["delete", "replace", "atomic replace"] as const) {
  test(`path ${operation} during a read → rejects the opened file's obsolete observation`, {
    skip:
      operation === "atomic replace" && process.platform === "win32"
        ? "Windows rename rejects a concurrently open target"
        : false,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hashline-read-path-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "source.txt");
    const replacement = join(directory, "replacement.txt");
    await writeFile(path, "中文\n");
    await writeFile(replacement, "汉字\n");
    await assert.rejects(
      readFileRevision(path, new AbortController().signal, {
        extent: "size",
        async onChunk() {
          if (operation !== "atomic replace") await rm(path);
          if (operation !== "delete") await rename(replacement, path);
        },
      }),
      /File changed/,
    );
    if (operation === "delete") await assert.rejects(readFile(path), { code: "ENOENT" });
    else assert.equal(await readFile(path, "utf8"), "汉字\n");
  });
}

test("zero-size procfs file → text reads to EOF while mutation revisions use the recorded size", {
  skip: process.platform === "linux" ? false : "Linux procfs behavior",
}, async () => {
  const path = "/proc/version";
  const signal = new AbortController().signal;
  const bytes = await readFile(path);
  assert.equal((await stat(path)).size, 0);
  assert.ok(bytes.length > 0);
  assert.equal((await scanTextFile(path, { signal })).revision, byteRevision(bytes));
  assert.equal(await readFileRevision(path, signal), byteRevision(Buffer.alloc(0)));
});

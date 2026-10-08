import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { makeReadOverride } from "../pi/read-tool.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { withFileRead } from "../pi/file-read.ts";

const CHUNK_BYTES = 64 * 1024;

test("read or CRLF search snapshot truncated across a UTF-8 sequence → reports file change without encoding blame", async (t) => {
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
    makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {}),
  ];
  for (const tool of tools) {
    await t.test(tool.name, async () => {
      await writeFile(path, source);
      const original = fs.createReadStream;
      let scans = 0;
      fs.createReadStream = (...args: Parameters<typeof original>) => {
        const stream = original(...args);
        if (args[0] === path && ++scans === (tool.name === "read" ? 1 : 2)) {
          stream.once("data", () => fs.truncateSync(path, CHUNK_BYTES - 1));
        }
        return stream;
      };
      syncBuiltinESMExports();
      try {
        const args =
          tool.name === "read" ? { path, limit: 1 } : { path, pattern: "head", literal: true };
        await assert.rejects(callTool(tool, args), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /File changed/);
          assert.doesNotMatch(error.message, /UNSUPPORTED_ENCODING|Invalid UTF-8/);
          return true;
        });
        const current = await readFile(path);
        assert.equal(isUtf8(current), true);
        assert.deepEqual(current, source.subarray(0, CHUNK_BYTES - 1));
      } finally {
        fs.createReadStream = original;
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
      withFileRead(path, undefined, async (handle) => {
        const bytes = await handle.readFile();
        if (operation !== "atomic replace") await rm(path);
        if (operation !== "delete") await rename(replacement, path);
        return bytes;
      }),
      /File changed/,
    );
    if (operation === "delete") await assert.rejects(readFile(path), { code: "ENOENT" });
    else assert.equal(await readFile(path, "utf8"), "汉字\n");
  });
}

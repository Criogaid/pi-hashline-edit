import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { byteRevision } from "./file-commit.ts";
import { join } from "node:path";
import { scanTextFile, scanTextLines } from "./text-stream.ts";
import { splitLines } from "../core/lines.ts";

async function withFile(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "hashline-stream-"));
  try {
    await run(join(directory, "text"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("streamed lines preserve BOM, standalone CR, and boundaries split across chunks", async () =>
  withFile(async (path) => {
    for (const text of [
      "",
      "\n",
      "\n\n",
      "a\r",
      "a\rb\n",
      "\uFEFFa\r\nb\nlast",
      "x".repeat(65535) + "😀\r\nnext\r",
      "x".repeat(65535) + "\r\nlast\n",
    ]) {
      await writeFile(path, text);
      const lines: string[] = [];
      const stats = await scanTextLines(
        path,
        () => true,
        (line) => {
          assert.equal(line.number, lines.length + 1);
          assert.equal(line.byteLength, Buffer.byteLength(line.text!));
          lines.push(line.text!);
        },
      );
      assert.deepEqual(lines, splitLines(text));
      assert.equal(stats.totalLines, lines.length);
      assert.equal(stats.finalNewline, text === "" || text.endsWith("\n"));
      assert.equal(stats.hasCrLf, text.includes("\r\n"));
      assert.equal(stats.byteLength, Buffer.byteLength(text));
    }
  }));

test("streamed byte digests preserve the source revision across BOM, CRLF, and chunk boundaries", async () =>
  withFile(async (path) => {
    const source = Buffer.from(`\uFEFFfirst\r\n${"a".repeat(65536)}\r\nlast\r`);
    await writeFile(path, source);
    const first = createHash("sha256");
    const stats = await scanTextFile(path, undefined, undefined, (bytes) => first.update(bytes));
    assert.equal(stats.hasCrLf, true);
    assert.equal(first.digest("hex"), byteRevision(source));
    const second = createHash("sha256");
    await scanTextLines(
      path,
      (number) => number === 1,
      () => {},
      {
        onBytes: (bytes) => second.update(bytes),
      },
    );
    assert.equal(second.digest("hex"), byteRevision(source));
  }));

test("streamed selection discards oversized content and still counts and reads subsequent lines", async () =>
  withFile(async (path) => {
    await writeFile(path, "z".repeat(2 * 1024 * 1024) + "\n界\r\nkeep\nignored\n");
    const seen: unknown[] = [];
    const stats = await scanTextLines(
      path,
      (number) => number <= 3,
      (line) => seen.push(line),
      { maxLineBytes: 4 },
    );
    assert.equal(stats.totalLines, 4);
    assert.deepEqual(seen, [
      { number: 1, byteLength: 2 * 1024 * 1024, carriageReturns: 0, text: undefined },
      { number: 2, byteLength: 3, carriageReturns: 0, text: "界" },
      { number: 3, byteLength: 4, carriageReturns: 0, text: "keep" },
    ]);
  }));

test("streamed validation checks the entire file and gives NUL precedence over malformed UTF-8", async () =>
  withFile(async (path) => {
    await writeFile(
      path,
      Buffer.concat([Buffer.from("visible\n"), Buffer.alloc(65536, 97), Buffer.from([0xf0, 0x9f])]),
    );
    await assert.rejects(
      scanTextLines(
        path,
        (number) => number === 1,
        () => {},
      ),
      /UNSUPPORTED_ENCODING/,
    );
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xff]), Buffer.alloc(65536, 97), Buffer.from([0])]),
    );
    assert.equal((await scanTextFile(path)).hasNul, true);
  }));

test("streamed reads propagate cancellation", async () =>
  withFile(async (path) => {
    await writeFile(path, "a".repeat(2 * 65536));
    const controller = new AbortController();
    await assert.rejects(
      scanTextFile(path, () => controller.abort(), controller.signal),
      { message: "Operation aborted" },
    );
  }));

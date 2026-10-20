import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { byteRevision } from "./file-revision.ts";
import { join } from "node:path";
import { scanTextFile, scanTextLines } from "./text-stream.ts";
import { splitLines } from "../core/lines.ts";
import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { truncateSync } from "node:fs";
import { Utf8DecodingError } from "../core/text.ts";
import { HashlineError } from "../core/errors.ts";

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
      assert.equal(stats.byteLength, Buffer.byteLength(text));
    }
  }));

test("streamed scans → return the revision of every original byte and byte-based chunk progress", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    for (const source of [
      Buffer.alloc(0),
      Buffer.from("\uFEFF"),
      Buffer.from("first\r\nlast\r\n"),
      Buffer.from("\uFEFF" + "a".repeat(chunkBytes - 4) + "😀\r\nlast"),
    ]) {
      await writeFile(path, source);
      const chunks: string[] = [];
      const progress: number[] = [];
      const stats = await scanTextFile(path, {
        onChunk(text, bytesRead) {
          chunks.push(text);
          progress.push(bytesRead);
        },
      });
      assert.equal(chunks.join(""), source.toString("utf8"));
      assert.equal(stats.revision, byteRevision(source));
      assert.equal(stats.byteLength, source.length);
      assert.equal(progress.at(-1) ?? 0, source.length);
      if (source.length > chunkBytes) assert.equal(progress[0], chunkBytes);
      const selected = await scanTextLines(
        path,
        (number) => number === 1,
        () => {},
      );
      assert.equal(selected.revision, stats.revision);
    }
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
      (error: unknown) => error instanceof Utf8DecodingError,
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
      scanTextFile(path, { onChunk: () => controller.abort(), signal: controller.signal }),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED",
    );
  }));

test("lossy decoding reports invalid UTF-8 across chunk boundaries and preserves raw revisions", async () =>
  withFile(async (path) => {
    const source = Buffer.concat([
      Buffer.from("\uFEFF" + "a".repeat(65532)),
      Buffer.from([0xf0, 0x9f]),
      Buffer.from("\r\nneedle "),
      Buffer.from([0xff]),
      Buffer.from("\r\nlast"),
    ]);
    await writeFile(path, source);
    const lines: string[] = [];
    const stats = await scanTextLines(
      path,
      () => true,
      (line) => lines.push(line.text ?? ""),
      {
        decoding: "lossy",
      },
    );
    assert.equal(stats.validUtf8, false);
    assert.equal(stats.hasNul, false);
    assert.deepEqual(lines, splitLines(source.toString("utf8")));
    assert.equal(stats.revision, byteRevision(source));
    await assert.rejects(
      scanTextFile(path),
      (error: unknown) => error instanceof Utf8DecodingError,
    );
  }));

test("strict scans encounter invalid UTF-8 → stop emitting text and reject decoding", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    const prefix = Buffer.alloc(chunkBytes, "a");
    const invalid = Buffer.alloc(chunkBytes, "b");
    invalid[0] = 0xff;
    const source = Buffer.concat([prefix, invalid, Buffer.from("later text\n")]);
    await writeFile(path, source);
    const emitted: string[] = [];
    await assert.rejects(
      scanTextFile(path, {
        onChunk: (text) => {
          emitted.push(text);
        },
      }),
      (error: unknown) => error instanceof Utf8DecodingError,
    );
    assert.equal(emitted.join(""), prefix.toString("utf8"));
  }));

test("lossy scans flush a multibyte sequence split across chunks and incomplete at EOF", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    const prefix = Buffer.alloc(chunkBytes - 1, "a");
    const source = Buffer.concat([prefix, Buffer.from([0xf0, 0x9f])]);
    await writeFile(path, source);
    const emitted: string[] = [];
    const stats = await scanTextFile(path, {
      onChunk: (text) => {
        emitted.push(text);
      },
      decoding: "lossy",
    });
    assert.equal(emitted.join(""), prefix.toString("utf8") + "�");
    assert.equal(emitted.at(-1), "�");
    assert.equal(stats.validUtf8, false);
    assert.equal(stats.hasNul, false);
    assert.equal(stats.byteLength, source.length);
  }));

test("lossy scans without a text consumer report validity and retain all raw bytes", async () =>
  withFile(async (path) => {
    const source = Buffer.concat([
      Buffer.from("\ufeffbefore\r\n"),
      Buffer.from([0xff, 0xf0, 0x9f]),
    ]);
    await writeFile(path, source);
    const stats = await scanTextFile(path, {
      decoding: "lossy",
    });
    assert.equal(stats.revision, byteRevision(source));
    assert.equal(stats.validUtf8, false);
    assert.equal(stats.hasNul, false);
    assert.equal(stats.totalLines, 2);
    assert.equal(stats.finalNewline, false);
    assert.equal(stats.byteLength, source.length);
  }));

test("NUL suppresses its chunk and all later text without flushing a pending sequence", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    const prefix = Buffer.alloc(chunkBytes - 1, "a");
    const source = Buffer.concat([
      prefix,
      Buffer.from([0xf0, 0, 0x9f]),
      Buffer.alloc(chunkBytes, "b"),
    ]);
    await writeFile(path, source);
    for (const decoding of ["strict", "lossy"] as const) {
      const emitted: string[] = [];
      const stats = await scanTextFile(path, {
        onChunk: (text) => {
          emitted.push(text);
        },
        decoding,
      });
      assert.equal(stats.hasNul, true);
      assert.equal(emitted.join(""), prefix.toString("utf8"));
      assert.equal(stats.revision, byteRevision(source));
    }
  }));

test("NUL takes precedence over earlier malformed UTF-8 in strict and lossy scans", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    const invalid = Buffer.alloc(chunkBytes, "a");
    invalid[0] = 0xff;
    const source = Buffer.concat([invalid, Buffer.from("\0later\n")]);
    await writeFile(path, source);
    for (const decoding of ["strict", "lossy"] as const) {
      const emitted: string[] = [];
      const stats = await scanTextFile(path, {
        onChunk: (text) => {
          emitted.push(text);
        },
        decoding,
      });
      assert.equal(stats.hasNul, true);
      assert.equal(stats.validUtf8, false);
      assert.equal(emitted.join(""), decoding === "strict" ? "" : invalid.toString("utf8"));
    }
  }));

test("valid file truncated across a pending UTF-8 sequence → scans report a changed file", async () =>
  withFile(async (path) => {
    const chunkBytes = 64 * 1024;
    const source = Buffer.from(
      "x".repeat(chunkBytes - 1) +
        "中" +
        "x".repeat(chunkBytes - 3) +
        "中" +
        "tail".repeat(chunkBytes),
    );
    assert.equal(isUtf8(source), true);
    for (const decoding of ["strict", "lossy"] as const) {
      await writeFile(path, source);
      let changed = false;
      await assert.rejects(
        scanTextFile(path, {
          onChunk: () => {
            if (changed) return;
            changed = true;
            truncateSync(path, chunkBytes - 1);
          },
          decoding,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /File changed/);
          assert.ok(!(error instanceof Utf8DecodingError));
          return true;
        },
      );
      assert.equal(isUtf8(await readFile(path)), true);
    }
  }));

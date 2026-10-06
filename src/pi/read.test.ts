import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { makeReadOverride } from "./read-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { FORGET_MIN_BYTES, formatKiB } from "./budgets.ts";
import { taggedResultId } from "./forget.testing.ts";

const DEFAULT_READ_MAX_BYTES = DEFAULT_CONFIG.read.maxKiB * 1024;

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Call a tool through Pi's argument preparation and schema validation, as production does. */
const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "0" });

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as Theme;

initTheme();

test("read execute: text outputs LINE#HASH│content", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "line1\nline2\n");
    const r: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const text = r.content[0];
    assert.equal(text.type, "text");
    assert.match(text.text, /1#[0-9A-Z]+│line1/);
    assert.match(text.text, /2#[0-9A-Z]+│line2/);
    assert.match(text.text, /f\.txt · 2 lines/);
  });
});

test("read execute: Pi-supported images without NUL bypass text decoding", async () =>
  withDir(async (dir) => {
    for (const [name, bytes, mime] of [
      ["picture.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"],
      ["picture.gif", Buffer.from("GIF89a"), "image/gif"],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      const result: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: name });
      assert.ok(result.content[0].text.startsWith(`Read image file [${mime}]`));
      assert.deepEqual(await readFile(join(dir, name)), bytes);
    }
  }));

test("read execute: a missing final newline is stated in the header", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "line1\nline2");
    const bare: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    assert.match(bare.content[0].text, /f\.txt · 2 lines · no trailing newline/);

    await writeFile(join(dir, "g.txt"), "line1\nline2\n");
    const terminated: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "g.txt" });
    assert.doesNotMatch(terminated.content[0].text, /no trailing newline/);
  });
});

test("hash length stays 4 even for runs of identical lines (no explosion)", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "\n\n\n\ncode\n");
    const r: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const text: string = r.content[0].text;
    for (const m of text.matchAll(/\d+#([0-9A-Z]+)│/g)) {
      assert.equal(m[1].length, 4, `anchor ${m[0]} hash is not 4 chars`);
    }
  });
});

test("read byte truncation counts UTF-8 and separators without cutting anchors", async () =>
  withDir(async (dir) => {
    const maxBytes = DEFAULT_READ_MAX_BYTES;
    const hashLen = DEFAULT_CONFIG.hashLen;
    const prefixBytes = Buffer.byteLength(`1#${"X".repeat(hashLen)}│`);
    const first = "界".repeat(40000);
    const second = "x".repeat(maxBytes - Buffer.byteLength(first) - 2 * prefixBytes);
    await writeFile(join(dir, "large.txt"), `${first}\n${second}\n`);
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "large.txt" });
    assert.equal(result.details.truncation.outputLines, 1);
    assert.equal(result.details.truncation.truncatedBy, "bytes");
    assert.equal(result.details.truncation.maxBytes, maxBytes);
    assert.match(result.content[0].text, new RegExp(`truncated.*${formatKiB(maxBytes)}`));
    assert.ok(
      result.content[0].text.includes(`1#${computeLineHash(1, first, hashLen)}│${first}\n`),
    );
    assert.doesNotMatch(result.content[0].text, /\n2#/);
    const next = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "large.txt",
      offset: 2,
      limit: 1,
    });
    assert.ok(next.content[0].text.includes(`2#${computeLineHash(2, second, hashLen)}│${second}`));
  }));

test("read reports an oversized first row without suggesting an ineffective retry", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "long.txt"), "x".repeat(DEFAULT_READ_MAX_BYTES));
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "long.txt" });
    assert.equal(result.details.truncation.firstLineExceedsLimit, true);
    assert.equal(result.details.truncation.outputLines, 0);
    assert.doesNotMatch(result.content[0].text, /^\d+#/m);
    assert.doesNotMatch(result.content[0].text, /use offset\/limit/);
    assert.match(result.content[0].text, /cannot split.*line/);
    assert.match(result.content[0].text, /bash.*chunks.*replace/);
  }));

test("read preserves empty files and explicit limits above the native default", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "empty.txt"), "");
    const empty = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "empty.txt" });
    assert.match(empty.content[0].text, /0 lines/);
    assert.equal(empty.details, undefined);
    await writeFile(join(dir, "many.txt"), "x\n".repeat(2001));
    const many = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "many.txt",
      limit: 2001,
    });
    assert.match(many.content[0].text, /\n2001#[0-9A-Z]+│x/);
    assert.equal(many.details, undefined);
  }));

test("read uses the configured default limit and respects explicit limits", async () =>
  withDir(async (dir) => {
    const defaultLimit = DEFAULT_CONFIG.read.defaultLimit;
    const totalLines = defaultLimit + 100;
    await writeFile(
      join(dir, "large.txt"),
      Array.from({ length: totalLines }, (_, i) => `line${i + 1}\n`).join(""),
    );
    for (const limit of [undefined, defaultLimit + 50]) {
      const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
        path: "large.txt",
        limit,
      });
      const end = limit ?? defaultLimit;
      assert.match(result.content[0].text, new RegExp(`large\\.txt · ${totalLines} lines`));
      assert.match(result.content[0].text, new RegExp(`\\n${end}#[0-9A-Z]+│line${end}`));
      assert.doesNotMatch(result.content[0].text, new RegExp(`\\n${end + 1}#[0-9A-Z]+│`));
      assert.deepEqual(result.details, {
        pagination: { start: 1, end, totalLines, nextOffset: end + 1 },
      });
      assert.match(result.content[0].text, new RegExp(`offset ${end + 1}`));
    }
  }));

test("read pagination supports offset windows and stops suggesting continuation at EOF", async () =>
  withDir(async (dir) => {
    const totalLines = DEFAULT_CONFIG.read.defaultLimit + 100;
    const start = 20;
    const end = start + DEFAULT_CONFIG.read.defaultLimit - 1;
    await writeFile(
      join(dir, "pages.txt"),
      Array.from({ length: totalLines }, (_, i) => `line${i + 1}\n`).join(""),
    );
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const page = await call(read, { path: "pages.txt", offset: start });
    assert.match(page.content[0].text, new RegExp(`offset ${end + 1}`));
    assert.deepEqual(page.details, {
      pagination: { start, end, totalLines, nextOffset: end + 1 },
    });
    const next = await call(read, {
      path: "pages.txt",
      offset: page.details.pagination.nextOffset,
    });
    assert.match(next.content[0].text, new RegExp(`\\n${end + 1}#[0-9A-Z]+│line${end + 1}`));
    assert.match(next.content[0].text, new RegExp(`\\n${totalLines}#[0-9A-Z]+│line${totalLines}`));
    assert.equal(next.details, undefined);
    assert.doesNotMatch(next.content[0].text, /to continue/);
    for (const offset of [totalLines - DEFAULT_CONFIG.read.defaultLimit + 1, totalLines + 1]) {
      const result = await call(read, { path: "pages.txt", offset });
      assert.equal(result.details, undefined);
      assert.doesNotMatch(result.content[0].text, /to continue/);
    }
  }));

test("read rejects noninteger and nonpositive offsets and limits before reading", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "pages.txt"), "first\nsecond\nthird\n");
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    for (const key of ["offset", "limit"] as const) {
      const schema = read.parameters.properties[key];
      assert.equal(schema.type, "number");
      assert.equal("minimum" in schema ? schema.minimum : undefined, 1);
      assert.equal("multipleOf" in schema ? schema.multipleOf : undefined, 1);
      assert.equal("maximum" in schema ? schema.maximum : undefined, Number.MAX_SAFE_INTEGER);
      for (const invalid of [
        0,
        -4,
        0.5,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const params = { path: "pages.txt", [key]: invalid };
        await assert.rejects(
          call(read, params),
          new RegExp(`Validation failed for tool "read":\\n {2}- ${key}: `),
        );
      }
    }
    assert.deepEqual(
      validateToolArguments(read as any, {
        type: "toolCall",
        id: "valid",
        name: "read",
        arguments: { path: "pages.txt", offset: 2, limit: 550 },
      }),
      { path: "pages.txt", offset: 2, limit: 550 },
    );
    await assert.rejects(
      call(read, { path: "missing.txt", offset: 1.5 }),
      /Validation failed for tool "read"/,
    );
    const page = await call(read, { path: "pages.txt", offset: 2, limit: 1 });
    assert.match(page.content[0].text, /\n2#[0-9A-Z]+│second/);
    assert.match(page.content[0].text, /offset 3/);
    assert.deepEqual(page.details, {
      pagination: { start: 2, end: 2, totalLines: 3, nextOffset: 3 },
    });
    await writeFile(join(dir, "long.txt"), "x".repeat(DEFAULT_READ_MAX_BYTES + 1));
    const long = await call(read, { path: "long.txt", offset: 1, limit: 1 });
    assert.equal(long.details.truncation.firstLineExceedsLimit, true);
    assert.equal(long.details.truncation.outputLines, 0);
    assert.equal(long.details.truncation.maxBytes, DEFAULT_READ_MAX_BYTES);
  }));

test("read schema rejects empty paths and unknown fields before file access", async () =>
  withDir(async (dir) => {
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const invalidArgs: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { path: "" },
      { path: "missing.txt", offest: 3 },
    ];
    for (const args of invalidArgs) {
      await assert.rejects(call(read, args), /Validation failed for tool "read"/);
    }
  }));

test("read byte truncation takes precedence over line pagination", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "large.txt"), `first\n${"x".repeat(DEFAULT_READ_MAX_BYTES)}\ntail\n`);
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "large.txt",
      limit: 2,
    });
    assert.equal(result.details.truncation.truncatedBy, "bytes");
    assert.equal(result.details.pagination, undefined);
    assert.equal(result.details.truncation.maxBytes, DEFAULT_READ_MAX_BYTES);
    assert.doesNotMatch(result.content[0].text, /showing lines|to continue/);
  }));

test("read bounds oversized selected lines while preserving truncation metadata and later anchors", async () =>
  withDir(async (dir) => {
    const long = "界".repeat(200_000);
    await writeFile(join(dir, "long.txt"), `first\r\n${long}\r\nlast`);
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const result = await call(read, { path: "long.txt" });
    assert.match(result.content[0].text, /1#[0-9A-Z]+│first/);
    assert.doesNotMatch(result.content[0].text, /2#[0-9A-Z]+│/);
    assert.equal(result.details.truncation.firstLineExceedsLimit, false);
    assert.equal(result.details.truncation.outputLines, 1);
    const expectedRows = ["first", long, "last"].map(
      (text, index) => `${index + 1}#${computeLineHash(index + 1, text, 4)}│${text}`,
    );
    assert.equal(result.details.truncation.totalBytes, Buffer.byteLength(expectedRows.join("\n")));
    const oversized = await call(read, { path: "long.txt", offset: 2, limit: 1 });
    assert.equal(oversized.details.truncation.firstLineExceedsLimit, true);
    assert.equal(oversized.details.truncation.outputBytes, 0);
    const last = await call(read, { path: "long.txt", offset: 3, limit: 1 });
    assert.match(last.content[0].text, /3#[0-9A-Z]+│last/);
    assert.match(last.content[0].text, /no trailing newline/);
  }));

test("read budgets visible standalone CR characters using rendered UTF-8 bytes", async () =>
  withDir(async (dir) => {
    const content = "\r".repeat(90_000);
    await writeFile(join(dir, "cr.txt"), content);
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "cr.txt", limit: 1 });
    assert.equal(result.details.truncation.firstLineExceedsLimit, true);
    assert.equal(result.details.truncation.outputBytes, 0);
    assert.equal(
      result.details.truncation.totalBytes,
      Buffer.byteLength(`1#${computeLineHash(1, content, 4)}│${"␍".repeat(content.length)}`),
    );
  }));

test("read renders native content without interpreting anchor-like prefixes", async () =>
  withDir(async (dir) => {
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    for (const content of ["12#abc│ordinary content", "12#ABCD│ordinary content"]) {
      for (const suffix of ["\n", "\n\0tail"]) {
        await writeFile(join(dir, "prefix.txt"), content + suffix);
        const result = await call(tool, { path: "prefix.txt" });
        // Round-trip details as persisted session results do before rendering.
        const rendered = tool.renderResult!(
          JSON.parse(JSON.stringify(result)),
          { expanded: true, isPartial: false },
          stubTheme as Theme,
          { args: { path: "prefix.txt" }, state: {}, cwd: dir, isError: false } as any,
        )
          .render(120)
          .join("\n");
        assert.ok(rendered.includes(content), rendered);
      }
    }
  }));

test("read accepts safe offsets and limits whose sum exceeds the safe integer range", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "range.txt"), "first\nsecond\nthird\n");
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    for (const offset of [2, 3, Number.MAX_SAFE_INTEGER]) {
      const result = await call(tool, {
        path: "range.txt",
        offset,
        limit: Number.MAX_SAFE_INTEGER,
      });
      assert.equal(result.details, undefined);
      assert.doesNotMatch(result.content[0].text, /to continue|│first/);
      if (offset <= 3) assert.match(result.content[0].text, /│third/);
      else assert.doesNotMatch(result.content[0].text, /│/);
    }
  }));

test("read text reaches the forget byte threshold → only eligible results receive a tag", async () =>
  withDir(async (dir) => {
    const path = join(dir, "threshold.txt");
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    await writeFile(path, "界\n");
    const initial: Awaited<ReturnType<typeof read.execute>> = await callTool(read, { path });
    const initialBlock = initial.content[0];
    assert.ok(initialBlock.type === "text");
    const initialBytes = Buffer.byteLength(initialBlock.text);
    for (const bytes of [FORGET_MIN_BYTES - 1, FORGET_MIN_BYTES, FORGET_MIN_BYTES + 1]) {
      await writeFile(path, `界${"x".repeat(bytes - initialBytes)}\n`);
      const result: Awaited<ReturnType<typeof read.execute>> = await callTool(
        read,
        { path },
        { toolCallId: `read-${bytes}` },
      );
      const body = result.content[0];
      assert.ok(body.type === "text");
      assert.equal(Buffer.byteLength(body.text), bytes);
      assert.equal(taggedResultId(result) !== undefined, bytes >= FORGET_MIN_BYTES);
    }
  }));

import { rejectsArgument, rejectsArguments } from "./argument-error.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { makeReadOverride } from "./read-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { DEFAULT_OUTPUT_BUDGETS, formatByteSize } from "./budgets.ts";
import { reportOf } from "./report.ts";
import { createAnchorFormatter } from "./anchor-format.ts";

const DEFAULT_READ_MAX_BYTES = DEFAULT_OUTPUT_BUDGETS.readBytes;

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
    const r = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const text = r.content[0];
    assert.equal(text.type, "text");
    assert.match(text.text, /1#[0-9A-Z]+│line1/);
    assert.match(text.text, /2#[0-9A-Z]+│line2/);
    assert.match(text.text, /f\.txt · 2 lines/);
  });
});

test("absolute path inside cwd → read header uses relative spelling", async () =>
  withDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "line1\nline2\n");
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text.split("\n")[0], "f.txt · 2 lines");
  }));

test(
  "Windows absolute path outside cwd → read header uses forward slashes",
  {
    skip: process.platform !== "win32",
  },
  async () =>
    withDir(async (dir) => {
      const cwd = join(dir, "workspace");
      await mkdir(cwd);
      const path = join(dir, "outside.txt");
      await writeFile(path, "line1\nline2\n");
      const result = await call(makeReadOverride(cwd, DEFAULT_CONFIG), { path });
      assert.equal(result.isError, undefined);
      assert.equal(
        result.content[0].text.split("\n")[0],
        `${path.replaceAll("\\", "/")} · 2 lines`,
      );
    }),
);

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
    assert.equal(reportOf(result, "read")?.outputLimit, formatByteSize(maxBytes));
    assert.ok(result.content[0].text.includes(`1#${computeLineHash(1, first, hashLen)}│${first}`));
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
    assert.doesNotMatch(result.content[0].text, /^\d+#/m);
    assert.doesNotMatch(result.content[0].text, /use offset\/limit/);
    assert.deepEqual(reportOf(result, "read")?.lineTooLong, {
      line: 1,
      limit: formatByteSize(DEFAULT_READ_MAX_BYTES),
    });
    assert.match(reportOf(result, "read")?.next ?? "", /chunks.*bash.*replace/);
  }));

test("read preserves empty files and explicit limits above the native default", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "empty.txt"), "");
    const empty = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "empty.txt" });
    assert.match(empty.content[0].text, /0 lines/);
    assert.equal(reportOf(empty, "read")?.pagination, undefined);
    await writeFile(join(dir, "many.txt"), "x\n".repeat(2001));
    const many = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "many.txt",
      limit: 2001,
    });
    assert.match(many.content[0].text, /\n2001#[0-9A-Z]+│x/);
    assert.equal(reportOf(many, "read")?.pagination, undefined);
  }));

test("read window end chosen by caller or default → only the default offers optional continuation", async () =>
  withDir(async (dir) => {
    const defaultLimit = DEFAULT_CONFIG.read.defaultLimit;
    const totalLines = defaultLimit + 100;
    await writeFile(
      join(dir, "large.txt"),
      Array.from({ length: totalLines }, (_, i) => `line${i + 1}\n`).join(""),
    );
    for (const limit of [undefined, defaultLimit, defaultLimit + 50]) {
      const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
        path: "large.txt",
        limit,
      });
      const end = limit ?? defaultLimit;
      assert.match(result.content[0].text, new RegExp(`large\\.txt · ${totalLines} lines`));
      assert.match(result.content[0].text, new RegExp(`\\n${end}#[0-9A-Z]+│line${end}`));
      assert.doesNotMatch(result.content[0].text, new RegExp(`\\n${end + 1}#[0-9A-Z]+│`));
      const pagination = { start: 1, end, totalLines, nextOffset: end + 1 };
      const report = reportOf(result, "read");
      assert.ok(report);
      if (limit === undefined) {
        assert.deepEqual(report.pagination, pagination);
        assert.match(report.next ?? "", /if you need more lines.*offset.*pagination\.nextOffset/i);
      } else {
        assert.equal(Object.hasOwn(report, "pagination"), false);
        assert.equal(Object.hasOwn(report, "next"), false);
      }
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
    assert.match(reportOf(page, "read")?.next ?? "", /offset.*pagination\.nextOffset/);
    assert.deepEqual(reportOf(page, "read")?.pagination, {
      start,
      end,
      totalLines,
      nextOffset: end + 1,
    });
    const pagination = reportOf(page, "read")?.pagination;
    assert.ok(pagination);
    const next = await call(read, {
      path: "pages.txt",
      offset: pagination.nextOffset,
    });
    assert.match(next.content[0].text, new RegExp(`\\n${end + 1}#[0-9A-Z]+│line${end + 1}`));
    assert.match(next.content[0].text, new RegExp(`\\n${totalLines}#[0-9A-Z]+│line${totalLines}`));
    assert.equal(reportOf(next, "read")?.pagination, undefined);
    assert.equal(reportOf(next, "read")?.next, undefined);
    for (const offset of [totalLines - DEFAULT_CONFIG.read.defaultLimit + 1, totalLines + 1]) {
      const result = await call(read, { path: "pages.txt", offset });
      assert.equal(reportOf(result, "read")?.pagination, undefined);
      assert.equal(reportOf(result, "read")?.next, undefined);
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
        await assert.rejects(call(read, params), rejectsArgument(key));
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
    await assert.rejects(call(read, { path: "missing.txt", offset: 1.5 }), rejectsArguments());
  }));

test("read schema rejects empty paths and unknown fields before file access", async () =>
  withDir(async (dir) => {
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const invalidArgs: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { path: "" },
      { path: "missing.txt", offest: 3 },
    ];
    for (const args of invalidArgs) {
      await assert.rejects(call(read, args), rejectsArguments());
    }
  }));

test("read byte truncation retains its budget and a continuation after complete returned rows", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "large.txt"), `first\n${"x".repeat(DEFAULT_READ_MAX_BYTES)}\ntail\n`);
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "large.txt",
      limit: 2,
    });
    assert.deepEqual(reportOf(result, "read")?.pagination, {
      start: 1,
      end: 1,
      totalLines: 3,
      nextOffset: 2,
    });
    assert.equal(reportOf(result, "read")?.outputLimit, formatByteSize(DEFAULT_READ_MAX_BYTES));
    assert.match(reportOf(result, "read")?.next ?? "", /offset.*pagination\.nextOffset/);
    assert.doesNotMatch(result.content[0].text, /showing lines|to continue/);
  }));

test("read bounds oversized selected lines while reporting limits and preserving later anchors", async () =>
  withDir(async (dir) => {
    const long = "界".repeat(200_000);
    await writeFile(join(dir, "long.txt"), `first\r\n${long}\r\nlast`);
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const result = await call(read, { path: "long.txt" });
    assert.match(result.content[0].text, /1#[0-9A-Z]+│first/);
    assert.doesNotMatch(result.content[0].text, /2#[0-9A-Z]+│/);
    assert.equal(reportOf(result, "read")?.lineTooLong, undefined);
    assert.equal(reportOf(result, "read")?.outputLimit, formatByteSize(DEFAULT_READ_MAX_BYTES));
    const oversized = await call(read, { path: "long.txt", offset: 2, limit: 1 });
    assert.deepEqual(reportOf(oversized, "read")?.lineTooLong, {
      line: 2,
      limit: formatByteSize(DEFAULT_READ_MAX_BYTES),
    });
    assert.doesNotMatch(oversized.content[0].text, /^\d+#/m);
    const last = await call(read, { path: "long.txt", offset: 3, limit: 1 });
    assert.match(last.content[0].text, /3#[0-9A-Z]+│last/);
    assert.match(last.content[0].text, /no trailing newline/);
  }));

test("read budgets visible standalone CR characters using rendered UTF-8 bytes", async () =>
  withDir(async (dir) => {
    const content = "\r".repeat(90_000);
    await writeFile(join(dir, "cr.txt"), content);
    const result = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "cr.txt", limit: 1 });
    assert.deepEqual(reportOf(result, "read")?.lineTooLong, {
      line: 1,
      limit: formatByteSize(DEFAULT_READ_MAX_BYTES),
    });
    assert.doesNotMatch(result.content[0].text, /^\d+#/m);
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
      assert.equal(reportOf(result, "read")?.pagination, undefined);
      assert.doesNotMatch(result.content[0].text, /to continue|│first/);
      if (offset <= 3) assert.match(result.content[0].text, /│third/);
      else assert.doesNotMatch(result.content[0].text, /│/);
    }
  }));

test("Unicode line separators in a read path or middle row → renders every following row", async (t) => {
  const tool = makeReadOverride(process.cwd(), DEFAULT_CONFIG);
  const render = tool.renderResult;
  assert.ok(render);
  const formatter = createAnchorFormatter(DEFAULT_CONFIG.hashLen);
  for (const separator of ["\u2028", "\u2029"]) {
    for (const location of ["path", "middle row"]) {
      await t.test(`${location} ${JSON.stringify(separator)}`, () => {
        const path = location === "path" ? `before${separator}after.txt` : "read.txt";
        const lines = [
          "first",
          location === "middle row" ? `before${separator}after` : "middle",
          "third",
          "last",
        ];
        const header = `${path} · ${lines.length} lines`;
        const raw = [header, ...lines.map((line, index) => formatter.row(index + 1, line))].join(
          "\n",
        );
        const rendered = render(
          { content: [{ type: "text", text: raw }], details: undefined },
          { expanded: true, isPartial: false },
          stubTheme,
          {
            args: { path },
            state: {},
            cwd: process.cwd(),
            toolCallId: "unicode-read",
            lastComponent: undefined,
            invalidate() {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
          },
        )
          .render(120)
          .map((line) => line.trimEnd());
        assert.deepEqual(rendered, [
          header,
          ...lines.map((line, index) => `   ${index + 1}: ${line}`),
        ]);
      });
    }
  }
});

import { rejectsArgument, rejectsArguments } from "./argument-error.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { makeReadOverride } from "./tool-factories.testing.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./tool-factories.testing.ts";
import { formatByteSize, outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
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

test("read anchors omitted, true, or null → preserves anchored text output", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "line1\nline2\n");
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    const formatter = createAnchorFormatter(DEFAULT_CONFIG.hashLen);
    for (const options of [{}, { anchors: true }, { anchors: null }]) {
      const result = await callTool(tool, { path: "f.txt", ...options });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].type, "text");
      assert.equal(
        result.content[0].text,
        ["f.txt · 2 lines", formatter.row(1, "line1"), formatter.row(2, "line2")].join("\n"),
      );
    }
  });
});

test("read without anchors → preserves the header and raw window with LF and visible standalone CR", async () =>
  withDir(async (dir) => {
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    const lines = ["first", "second␍third", "", "12#ABCD│literal"];
    for (const ending of ["\r\n", ""]) {
      await writeFile(
        join(dir, "raw.txt"),
        `first\r\nsecond\rthird\r\n\r\n12#ABCD│literal${ending}`,
      );
      for (const [offset, limit] of [
        [undefined, undefined],
        [2, 2],
        [2, 3],
      ] as const) {
        const start = offset ?? 1;
        const result = await callTool(tool, { path: "raw.txt", anchors: false, offset, limit });
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].type, "text");
        const header = `raw.txt · 4 lines${start > 1 ? ` (from line ${start})` : ""}${ending ? "" : " · no trailing newline"}`;
        assert.equal(
          result.content[0].text,
          `${header}\n${lines.slice(start - 1, limit === undefined ? undefined : start - 1 + limit).join("\n")}`,
        );
        const report = reportOf(result, "read");
        assert.equal(report?.nextOffset, undefined);
        assert.equal(report?.outputLimit, undefined);
        assert.equal(report?.lineTooLong, undefined);
      }
    }
  }));

test("read without anchors at the same byte cap → fits more complete rows and retains byte-limit pagination", async () =>
  withDir(async (dir) => {
    const budget = outputBudgetsFor(2_048);
    const tool = makeReadOverride(dir, DEFAULT_CONFIG, () => budget);
    const visibleLine = "界␍x";
    const rowCount = Math.floor((budget.readBytes + 1) / (Buffer.byteLength(visibleLine) + 1));
    const totalLines = rowCount + 2;
    await writeFile(join(dir, "raw.txt"), Array(totalLines).fill("界\rx").join("\r\n"));
    const anchored = await callTool(tool, { path: "raw.txt", limit: totalLines });
    const raw = await callTool(tool, { path: "raw.txt", limit: totalLines, anchors: false });
    assert.equal(raw.isError, undefined);
    assert.equal(raw.content[0].type, "text");
    assert.equal(
      raw.content[0].text,
      `raw.txt · ${totalLines} lines · no trailing newline\n${Array(rowCount).fill(visibleLine).join("\n")}`,
    );
    const report = reportOf(raw, "read");
    const anchoredReport = reportOf(anchored, "read");
    assert.equal(report?.nextOffset, rowCount + 1);
    assert.ok(anchoredReport?.nextOffset);
    assert.ok(rowCount + 1 > anchoredReport.nextOffset);
    for (const facts of [report, anchoredReport]) {
      assert.equal(facts?.outputLimit, formatByteSize(budget.readBytes));
      assert.equal(facts?.lineTooLong, undefined);
    }
    const next = await callTool(tool, {
      path: "raw.txt",
      anchors: false,
      offset: report.nextOffset,
    });
    assert.equal(next.content[0].type, "text");
    assert.equal(
      next.content[0].text,
      `raw.txt · ${totalLines} lines (from line ${rowCount + 1}) · no trailing newline\n${visibleLine}\n${visibleLine}`,
    );
    assert.equal(reportOf(next, "read")?.nextOffset, undefined);
    assert.equal(reportOf(next, "read")?.outputLimit, undefined);
  }));

test("read without anchors first row at or beyond the byte cap → counts UTF-8 content without a prefix", async () =>
  withDir(async (dir) => {
    const budget = outputBudgetsFor(2_048);
    const tool = makeReadOverride(dir, DEFAULT_CONFIG, () => budget);
    const content = "界".repeat(Math.floor(budget.readBytes / Buffer.byteLength("界")));
    const fitting = content + "x".repeat(budget.readBytes - Buffer.byteLength(content));
    for (const [source, fits] of [
      [fitting, true],
      [fitting + "x", false],
      ["\r".repeat(Math.floor(budget.readBytes / Buffer.byteLength("␍")) + 1), false],
    ] as const) {
      await writeFile(join(dir, "raw.txt"), source);
      const result = await callTool(tool, { path: "raw.txt", anchors: false });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].type, "text");
      assert.equal(
        result.content[0].text,
        `raw.txt · 1 lines · no trailing newline\n${fits ? source : ""}`,
      );
      const report = reportOf(result, "read");
      assert.equal(report?.lineTooLong, fits ? undefined : formatByteSize(budget.readBytes));
      assert.equal(report?.outputLimit, undefined);
      assert.equal(report?.nextOffset, undefined);
    }
  }));

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

test("read supported PNG → exposes the native image schema and structured image", async () =>
  withDir(async (dir) => {
    await writeFile(
      join(dir, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    const result = await callTool(tool, { path: "image.png" });
    assert.equal(result.isError, undefined);
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image, JSON.stringify(result.content));
    assert.equal(image.mimeType, "image/png");
    assert.ok(image.data.length > 0);
    assert.deepEqual(result.structuredContent, {
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
      note: result.content.find((block) => block.type === "text")?.text,
    });
    const nativeSchema = createReadToolDefinition(dir).outputSchema;
    assert.ok(nativeSchema);
    assert.deepEqual(tool.outputSchema, nativeSchema);
  }));

test("read UTF-8 text with or without continuation → structured text includes every text block", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "text.txt"), "第一行\r\nsecond\r\n");
    const tool = makeReadOverride(dir, {
      ...DEFAULT_CONFIG,
      read: { ...DEFAULT_CONFIG.read, defaultLimit: 1 },
    });
    for (const limit of [undefined, 2]) {
      const result = await callTool(tool, { path: "text.txt", limit });
      assert.equal(result.isError, undefined);
      const textBlocks = result.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      );
      assert.equal(textBlocks.length, limit === undefined ? 2 : 1);
      assert.equal(reportOf(result, "read")?.nextOffset, limit === undefined ? 2 : undefined);
      assert.equal(typeof result.structuredContent, "string");
      assert.equal(result.structuredContent, textBlocks.join("\n"));
    }
  }));

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

test("missing canonical read path with a native filename variant → reports the missing target", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "shot 9\u202fAM.txt"), "variant must not be read\n");
    const result = await callTool(makeReadOverride(dir, DEFAULT_CONFIG), { path: "shot 9 AM.txt" });
    assert.equal(result.isError, true);
    const report = reportOf(result, "read");
    assert.equal(report?.error, "PATH_NOT_FOUND");
    assert.deepEqual(report?.missing, [join(dir, "shot 9 AM.txt")]);
  }));

test("file URLs escape special filenames → text and delegated reads open the exact file", async (t) => {
  await withDir(async (dir) => {
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    const cases = [
      { name: "text.txt", bytes: Buffer.from("first\nsecond\n"), native: false },
      { name: "binary.bin", bytes: Buffer.from("first\0\nsecond\n"), native: true },
      {
        name: "image.gif",
        bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
        native: true,
      },
    ];
    for (const { name, bytes, native } of cases) {
      await t.test(name, async () => {
        const path = join(dir, `space\u202Fname #% ${name}`);
        await writeFile(path, bytes);
        const result = await callTool(tool, { path: pathToFileURL(path).href });
        assert.equal(result.isError, undefined);
        assert.equal(result.details?.nativeRead === true, native);
        if (name === "image.gif") {
          assert.ok(result.content.some((block) => block.type === "image"));
        } else {
          const text = result.content.find((block) => block.type === "text")?.text;
          assert.ok(text);
          assert.ok(text.includes(native ? "first\0" : "│first"));
          assert.ok(text.includes("second"));
          if (!native) {
            const header = text.split("\n")[0];
            const returnedPath = header.slice(0, header.lastIndexOf(" · "));
            const reread = await callTool(tool, { path: returnedPath });
            assert.equal(reread.isError, undefined);
            assert.deepEqual(reread.content, result.content);
          }
        }
        assert.deepEqual(await readFile(path), bytes);
      });
    }
  });
});

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
    const rows = [...text.matchAll(/^(\d+)#([0-9A-Z]+)│(.*)$/gm)];
    assert.deepEqual(
      rows.map((row) => [Number(row[1]), row[3]]),
      [
        [1, ""],
        [2, ""],
        [3, ""],
        [4, ""],
        [5, "code"],
      ],
    );
    for (const row of rows) assert.equal(row[2].length, DEFAULT_CONFIG.hashLen);
  });
});

test("read byte truncation counts UTF-8 and separators without cutting anchors", async () =>
  withDir(async (dir) => {
    const maxBytes = DEFAULT_READ_MAX_BYTES;
    const hashLen = DEFAULT_CONFIG.hashLen;
    const prefixBytes = Buffer.byteLength(`1#${"X".repeat(hashLen)}│`);
    const first = "界".repeat(Math.floor(maxBytes / (2 * Buffer.byteLength("界"))));
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
    assert.equal(reportOf(result, "read")?.lineTooLong, formatByteSize(DEFAULT_READ_MAX_BYTES));
    assert.match(reportOf(result, "read")?.next ?? "", /chunks.*bash.*replace/);
  }));

test("read preserves empty files and explicit limits above the native default", async () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "empty.txt"), "");
    const empty = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "empty.txt" });
    assert.match(empty.content[0].text, /0 lines/);
    assert.equal(reportOf(empty, "read")?.nextOffset, undefined);
    await writeFile(join(dir, "many.txt"), "x\n".repeat(2001));
    const many = await call(makeReadOverride(dir, DEFAULT_CONFIG), {
      path: "many.txt",
      limit: 2001,
    });
    assert.match(many.content[0].text, /\n2001#[0-9A-Z]+│x/);
    assert.equal(reportOf(many, "read")?.nextOffset, undefined);
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
      const nextOffset = end + 1;
      const report = reportOf(result, "read");
      assert.ok(report);
      if (limit === undefined) {
        assert.equal(report.nextOffset, nextOffset);
        assert.match(report.next ?? "", /if you need more lines.*offset.*nextOffset/i);
      } else {
        assert.equal(Object.hasOwn(report, "nextOffset"), false);
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
    assert.match(reportOf(page, "read")?.next ?? "", /offset.*nextOffset/);
    const nextOffset = reportOf(page, "read")?.nextOffset;
    assert.ok(nextOffset);
    const next = await call(read, {
      path: "pages.txt",
      offset: nextOffset,
    });
    assert.match(next.content[0].text, new RegExp(`\\n${end + 1}#[0-9A-Z]+│line${end + 1}`));
    assert.match(next.content[0].text, new RegExp(`\\n${totalLines}#[0-9A-Z]+│line${totalLines}`));
    assert.equal(reportOf(next, "read")?.nextOffset, undefined);
    assert.equal(reportOf(next, "read")?.next, undefined);
    for (const offset of [totalLines - DEFAULT_CONFIG.read.defaultLimit + 1, totalLines + 1]) {
      const result = await call(read, { path: "pages.txt", offset });
      assert.equal(reportOf(result, "read")?.nextOffset, undefined);
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
    assert.equal(reportOf(result, "read")?.nextOffset, 2);
    assert.equal(reportOf(result, "read")?.outputLimit, formatByteSize(DEFAULT_READ_MAX_BYTES));
    assert.match(reportOf(result, "read")?.next ?? "", /offset.*nextOffset/);
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
    assert.equal(reportOf(oversized, "read")?.lineTooLong, formatByteSize(DEFAULT_READ_MAX_BYTES));
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
    assert.equal(reportOf(result, "read")?.lineTooLong, formatByteSize(DEFAULT_READ_MAX_BYTES));
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
      assert.equal(reportOf(result, "read")?.nextOffset, undefined);
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
            durationMs: undefined,
            outputPad: 1,
            keyText: () => "",
            keyHint: (_key, description) => description,
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

test("raw read rendering with an offset → numbers every source line from the header without parsing its content", async () =>
  withDir(async (dir) => {
    const tool = makeReadOverride(dir, DEFAULT_CONFIG);
    const render = tool.renderResult;
    assert.ok(render);
    const lines = ["12#ABCD│literal", "", "before\u2028middle\u2029after", "last"];
    await writeFile(join(dir, "raw.txt"), lines.join("\n"));
    for (const offset of [1, 2]) {
      const args = { path: "raw.txt", anchors: false, offset };
      const result = await callTool(tool, args);
      const rendered: string[] = render(
        JSON.parse(JSON.stringify(result)),
        { expanded: true, isPartial: false },
        stubTheme,
        {
          args,
          state: {},
          cwd: dir,
          toolCallId: "raw-read",
          lastComponent: undefined,
          invalidate() {},
          executionStarted: true,
          durationMs: undefined,
          outputPad: 1,
          keyText: () => "",
          keyHint: (_key, description) => description,
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
        `raw.txt · 4 lines${offset > 1 ? ` (from line ${offset})` : ""} · no trailing newline`,
        ...lines
          .slice(offset - 1)
          .map((line, index) => `   ${offset + index}:${line ? ` ${line}` : ""}`),
      ]);
    }
  }));

test("unanchored read with no rows or a real empty row → expanded rendering preserves the selected rows", async (t) =>
  withDir(async (dir) => {
    const budget = outputBudgetsFor(4_000);
    const tool = makeReadOverride(dir, DEFAULT_CONFIG, () => budget);
    const render = tool.renderResult;
    assert.ok(render);
    const cases = [
      { name: "empty file", path: "empty.txt", content: "", header: "empty.txt · 0 lines" },
      {
        name: "offset past EOF",
        path: "blank.txt",
        content: "a\n\nb\n",
        offset: 9,
        header: "blank.txt · 3 lines (from line 9)",
      },
      {
        name: "first line exceeds the byte budget",
        path: "long.txt",
        content: "x".repeat(budget.readBytes + 1) + "\n",
        header: "long.txt · 1 lines",
        lineTooLong: true,
      },
      {
        name: "real empty row",
        path: "blank.txt",
        content: "a\n\nb\n",
        offset: 2,
        limit: 1,
        header: "blank.txt · 3 lines (from line 2)",
        emptyRow: true,
      },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        await writeFile(join(dir, c.path), c.content);
        const args = { path: c.path, anchors: false, offset: c.offset, limit: c.limit };
        const result = await callTool(tool, args);
        assert.equal(result.isError, undefined);
        const rendered = render(
          JSON.parse(JSON.stringify(result)),
          { expanded: true, isPartial: false },
          stubTheme,
          {
            args,
            state: {},
            cwd: dir,
            toolCallId: "raw-read",
            lastComponent: undefined,
            invalidate() {},
            executionStarted: true,
            durationMs: undefined,
            outputPad: 1,
            keyText: () => "",
            keyHint: (_key, description) => description,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
          },
        ).render(120);
        assert.equal(rendered[0].trimEnd(), c.header);
        const codeRows = rendered.slice(1).filter((line) => /^\s+\d+: /.test(line));
        if (c.emptyRow) {
          assert.equal(codeRows.length, 1);
          assert.ok(codeRows[0].startsWith("   2: "));
          assert.equal(codeRows[0].trimEnd(), "   2:");
        } else {
          assert.deepEqual(codeRows, []);
        }
        if (c.lineTooLong) {
          assert.equal(reportOf(result, "read")?.lineTooLong, formatByteSize(budget.readBytes));
          assert.ok(
            rendered.some((line) =>
              line.includes(`lineTooLong: ${formatByteSize(budget.readBytes)}`),
            ),
          );
          assert.ok(rendered.some((line) => line.includes("next: ")));
        }
      });
    }
  }));

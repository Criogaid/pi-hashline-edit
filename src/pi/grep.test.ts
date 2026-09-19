/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { getState } from "./state.ts";

type FakeOptions = {
  lines?: string[];
  code?: number | null;
  stderr?: string;
  validation?: { code: number | null; stderr: string };
  error?: Error;
  onRun?: () => void;
};

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-grep-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function rgMatch(filePath: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: "match",
    data: { path: { text: filePath }, line_number: lineNumber, lines: { text } },
  });
}

function fakeBackend(options: FakeOptions = {}) {
  const calls: { path: string; args: string[] }[] = [];
  const delegates: any[][] = [];
  const backend: GrepBackend = {
    async findRg() {
      return "/fake/rg";
    },
    async runRg(path, args, _signal, onLine) {
      calls.push({ path, args });
      options.onRun?.();
      if (options.error) throw options.error;
      if (args.includes("--quiet")) {
        return { code: 1, stderr: "", ...options.validation, stopped: false };
      }
      for (const line of options.lines ?? []) {
        if (!onLine(line)) return { code: null, stderr: options.stderr ?? "", stopped: true };
      }
      return {
        code: options.code === undefined ? 0 : options.code,
        stderr: options.stderr ?? "",
        stopped: false,
      };
    },
    async delegate(...args) {
      delegates.push(args);
      return { content: [{ type: "text", text: "delegated" }], details: undefined };
    },
  };
  return { backend, calls, delegates };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  tool.execute("0", params, signal, undefined);

async function withEnabled<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const state = getState();
  const previous = state.config.enabled;
  state.config.enabled = enabled;
  try {
    return await fn();
  } finally {
    state.config.enabled = previous;
  }
}

test("formats parsed rg matches with full-line hash anchors", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "alpha beta\ngamma\nalpha only\n");
      await writeFile(b, "alpha here\n");
      const fake = fakeBackend({
        lines: [
          "not json",
          JSON.stringify({ type: "begin" }),
          rgMatch(a, 1, "alpha beta\n"),
          rgMatch(a, 3, "alpha only\n"),
          rgMatch(b, 1, "alpha here\n"),
        ],
      });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      assert.deepEqual(tool.parameters.required, ["pattern"]);
      const result = await call(tool, {
        pattern: "alpha",
      });
      const output = text(result);
      assert.match(output, /a\.ts · 2 matches/);
      assert.match(output, /b\.ts · 1 match/);
      assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta")}│alpha beta`));
      assert.match(output, /3#[0-9A-Z]+│alpha only/);
      assert.deepEqual(fake.calls[0], {
        path: "/fake/rg",
        args: ["--json", "--line-number", "--color=never", "--hidden", "--ignore-case", "--fixed-strings", "-e", "alpha", "--", dir],
      });
    }),
  );
});

test("grep in a subdirectory returns a path that edits the matching file", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      await mkdir(join(dir, "src"));
      const original = "export const status = 1;\n";
      const rootFile = join(dir, "status.ts");
      const matchedFile = join(dir, "src", "status.ts");
      await writeFile(rootFile, original);
      await writeFile(matchedFile, original);
      const fake = fakeBackend({ lines: [rgMatch(matchedFile, 1, original)] });
      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "status",
        path: "src",
      });
      const output = text(result);
      const displayPath = output.split(" · ")[0];
      const edit: any = makeEditOverride(dir);
      await call(edit, {
        path: displayPath,
        edits: [
          {
            op: "replace",
            anchor: `1#${computeLineHash(1, original.trimEnd())}`,
            body: ["export const status = 2;"],
          },
        ],
      });
      assert.equal(await readFile(matchedFile, "utf-8"), "export const status = 2;\n");
      assert.equal(await readFile(rootFile, "utf-8"), original);
    }),
  );
});

test("applies all, exclude, context, and CRLF filtering after rg output", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(
        file,
        "outside-before\r\nalpha beta drop\r\nbefore survivor\r\nalpha beta\r\nafter survivor\r\nalpha only\r\noutside-after\r\n",
      );
      const fake = fakeBackend({
        lines: [
          rgMatch(file, 2, "alpha beta drop\r\n"),
          rgMatch(file, 4, "alpha beta\r\n"),
          rgMatch(file, 6, "alpha only\r\n"),
        ],
      });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      const contextSchema: any = tool.parameters.properties.context;
      assert.equal(contextSchema.type, "integer");
      assert.equal(contextSchema.minimum, 0);
      assert.equal(contextSchema.maximum, 20);
      const result = await call(tool, {
        pattern: ["alpha", "beta$"],
        matchMode: "all",
        excludePattern: "drop",
        context: 1.9,
      });
      assert.equal(
        text(result),
        [
          "a.ts · 1 match",
          `3#${computeLineHash(3, "before survivor")}│before survivor`,
          `4#${computeLineHash(4, "alpha beta")}│alpha beta`,
          `5#${computeLineHash(5, "after survivor")}│after survivor`,
        ].join("\n"),
      );
    }),
  );
});

test("passes output flags and formats files and counts", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "Foo a.b\n");
      await writeFile(b, "foo a.b\n");
      const fake = fakeBackend({ lines: [rgMatch(a, 1, "Foo a.b\n"), rgMatch(b, 1, "foo a.b\n")] });

      const files = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: ["Foo", "a.b"],
        path: ["a.ts", "b.ts"],
        glob: ["*.ts", "!**/*.test.ts"],
        ignoreCase: true,
        literal: true,
        wordMatch: true,
        outputMode: "files",
      });
      assert.equal(text(files), "a.ts\nb.ts");
      assert.deepEqual(fake.calls[0].args, [
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
        "--ignore-case",
        "--fixed-strings",
        "--word-regexp",
        "--glob",
        "*.ts",
        "--glob",
        "!**/*.test.ts",
        "-e",
        "Foo",
        "-e",
        "a.b",
        "--",
        a,
        b,
      ]);

      const count = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "foo",
        outputMode: "count",
      });
      assert.equal(text(count), "a.ts: 1\nb.ts: 1\nTotal: 2 matches in 2 files");
    }),
  );
});

test("counts only surviving matches toward the limit and stops the fake runner", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "alpha beta\nalpha only\nalpha later\n");
      const fake = fakeBackend({
        lines: [
          rgMatch(file, 1, "alpha beta\n"),
          rgMatch(file, 2, "alpha only\n"),
          rgMatch(file, 3, "alpha later\n"),
        ],
      });

      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "alpha",
        excludePattern: "beta",
        limit: 1,
      });
      assert.match(text(result), /2#[0-9A-Z]+│alpha only/);
      assert.match(
        text(result),
        /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/,
      );
    }),
  );
});

test("auto-detects modes with rg validation while preserving explicit overrides", async () => {
  await withDir(async (dir) => {
    const valid = fakeBackend();
    const invalid = fakeBackend({ validation: { code: 2, stderr: "regex parse error:\nerror: unclosed group" } });
    const tool = makeGrepOverrideWithBackend(dir, valid.backend);
    const fallback = makeGrepOverrideWithBackend(dir, invalid.backend);

    const result = await call(fallback, { pattern: "queueTool(" });
    assert.match(text(result), /Invalid regex; searched all patterns as literal text/);
    await call(fallback, { pattern: ["plain", "broken("] });
    await call(tool, { pattern: "value.*" });
    await call(tool, { pattern: "plain", literal: false });
    await call(tool, { pattern: "value.*", literal: true });

    assert.deepEqual(
      [...invalid.calls, ...valid.calls].filter(({ args }) => !args.includes("--quiet"))
        .map(({ args }) => args.includes("--fixed-strings")),
      [true, true, false, false, true],
    );
    assert.equal(valid.calls.filter(({ args }) => args.includes("--quiet")).length, 1);
    assert.deepEqual(invalid.calls[0].args, ["--quiet", "-e", "queueTool(", "--", "-"]);

    const failed = fakeBackend({ validation: { code: 2, stderr: "Permission denied" } });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, failed.backend), { pattern: "value.*" }),
      /Permission denied/,
    );
    assert.equal(failed.calls.length, 1);
  });
});

test("uses smart-case by default and preserves explicit case overrides", async () => {
  await withDir(async (dir) => {
    const target = join(dir, "case.ts");
    await writeFile(target, "FOO alpha\n");

    const lower = fakeBackend({ lines: [rgMatch(target, 1, "FOO alpha\n")] });
    const lowerResult = await call(makeGrepOverrideWithBackend(dir, lower.backend), {
      pattern: ["foo", "alpha"],
      matchMode: "all",
    });
    assert.match(text(lowerResult), /FOO alpha/);

    const mixed = fakeBackend({ lines: [rgMatch(target, 1, "FOO alpha\n")] });
    const mixedResult = await call(makeGrepOverrideWithBackend(dir, mixed.backend), {
      pattern: ["Foo", "alpha"],
      matchMode: "all",
    });
    assert.equal(text(mixedResult), "No matches found");

    const flags = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, flags.backend);
    await call(tool, { pattern: "lower" });
    await call(tool, { pattern: "Upper" });
    await call(tool, { pattern: "lower", ignoreCase: true });
    await call(tool, { pattern: "lower", ignoreCase: false });
    await call(tool, { pattern: "foo\\S*" });
    await call(tool, { pattern: "foo\\S*", ignoreCase: true });
    assert.deepEqual(
      flags.calls.filter(({ args }) => !args.includes("--quiet"))
        .map(({ args }) => [args.includes("--ignore-case"), args.includes("--case-sensitive")]),
      [[true, false], [false, true], [true, false], [false, true], [false, true], [true, false]],
    );
  });
});

test("rejects empty and wildcard-only regexes without blocking literal or empty-line searches", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);

    for (const pattern of ["", "  ", []]) {
      await assert.rejects(call(tool, { pattern }), /pattern (?:is required|must not be empty)/);
    }
    for (const pattern of [".*", "^.+$", ".?", "*"]) {
      await assert.rejects(call(tool, { pattern }), /is wildcard-only/);
    }
    assert.equal(fake.calls.length, 0);

    assert.equal(text(await call(tool, { pattern: ".*", literal: true })), "No matches found");
    assert.equal(text(await call(tool, { pattern: "^$" })), "No matches found");
    assert.equal(fake.calls.filter(({ args }) => !args.includes("--quiet")).length, 2);
    assert.equal(fake.calls.filter(({ args }) => args.includes("--quiet")).length, 1);
  });
});

test("reports empty output and ripgrep execution failures", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const empty = fakeBackend({ code: 1 });
      assert.equal(
        text(await call(makeGrepOverrideWithBackend(dir, empty.backend), { pattern: "missing" })),
        "No matches found",
      );

      const failed = fakeBackend({ code: 2, stderr: "bad regex" });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, failed.backend), { pattern: "[", literal: false }),
        /bad regex/,
      );

      const rejected = fakeBackend({ error: new Error("spawn failed") });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, rejected.backend), { pattern: "x" }),
        /spawn failed/,
      );
    }),
  );
});

test("delegates only safe fallbacks and rejects extended missing-rg requests", async () => {
  await withDir(async (dir) => {
    const absent = fakeBackend();
    absent.backend.findRg = async () => null;
    await withEnabled(true, async () => {
      assert.equal(
        text(await call(makeGrepOverrideWithBackend(dir, absent.backend), { pattern: "x" })),
        "delegated",
      );
      assert.deepEqual(absent.delegates[0][1], { pattern: "x", ignoreCase: true, literal: true });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, absent.backend), {
          pattern: ["x", "y"],
          matchMode: "all",
        }),
        /ripgrep \(rg\) not found/,
      );
      assert.equal(absent.delegates.length, 1);
      assert.equal(absent.calls.length, 0);
    });
  });
});

test("delegates an already-aborted call and rejects an abort during rg execution", async () => {
  await withDir(async (dir) => {
    const alreadyAborted = fakeBackend();
    const first = new AbortController();
    first.abort();
    assert.equal(
      text(
        await call(
          makeGrepOverrideWithBackend(dir, alreadyAborted.backend),
          { pattern: ["x", "y"] },
          first.signal,
        ),
      ),
      "delegated",
    );

    const controller = new AbortController();
    const interrupted = fakeBackend({ onRun: () => controller.abort() });
    await assert.rejects(
      call(
        makeGrepOverrideWithBackend(dir, interrupted.backend),
        { pattern: ["x", "y"], matchMode: "all" },
        controller.signal,
      ),
      /Operation aborted/,
    );
  });
});

test("native fallback receives resolved defaults and preserves explicit overrides", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    fake.backend.findRg = async () => null;
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const cases = [
      { params: { pattern: "foo" }, literal: true, ignoreCase: true },
      { params: { pattern: "Foo" }, literal: true, ignoreCase: false },
      { params: { pattern: "(?i)foo" }, literal: false, ignoreCase: true },
      { params: { pattern: "(?P<name>foo)" }, literal: false, ignoreCase: false },
      { params: { pattern: "foo", literal: false, ignoreCase: false }, literal: false, ignoreCase: false },
      { params: { pattern: "queueTool(", literal: true, ignoreCase: true }, literal: true, ignoreCase: true },
    ];
    for (const { params, literal, ignoreCase } of cases) {
      const input = { ...params, path: "fixture.ts", glob: "*.ts", context: 2, limit: 3 };
      assert.equal(text(await call(tool, input)), "delegated");
      assert.deepEqual(fake.delegates.at(-1)![1], { ...input, literal, ignoreCase });
    }
    assert.equal(fake.delegates.length, cases.length);
    assert.equal(fake.calls.length, 0);
  });
});

test("native fallback retries only automatic regex parse failures as literal text", async () => {
  await withDir(async (dir) => {
    for (const scenario of ["auto", "explicit", "download", "abort"]) {
      const fake = fakeBackend();
      fake.backend.findRg = async () => null;
      const controller = new AbortController();
      const delegate = fake.backend.delegate;
      fake.backend.delegate = async (...args) => {
        const result = await delegate(...args);
        if (args[1].literal) return result;
        if (scenario === "abort") controller.abort();
        throw new Error(scenario === "download"
          ? "ripgrep (rg) is not available and could not be downloaded"
          : "rg: regex parse error:\nerror: unclosed group");
      };
      const params = { pattern: "queueTool(", ...(scenario === "explicit" ? { literal: false } : {}) };
      const result = call(makeGrepOverrideWithBackend(dir, fake.backend), params, controller.signal);
      if (scenario === "auto") {
        assert.deepEqual((await result).content, [
          { type: "text", text: "delegated" },
          { type: "text", text: "[Invalid regex; searched all patterns as literal text]" },
        ]);
        assert.equal(fake.delegates.length, 2);
        assert.deepEqual(fake.delegates[1][1], { pattern: "queueTool(", ignoreCase: false, literal: true });
      } else {
        await assert.rejects(result, scenario === "download" ? /could not be downloaded/
          : scenario === "abort" ? /Operation aborted/ : /regex parse error/);
        assert.equal(fake.delegates.length, 1);
      }
      assert.equal(fake.calls.length, 0);
    }
  });
});

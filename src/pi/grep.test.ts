/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import type { LinePredicate, SearchModes } from "./rg-line-filter.ts";
import { getState } from "./state.ts";

type FakeOptions = {
  lines?: string[];
  code?: number | null;
  stderr?: string;
  validation?: { code: number | null; stderr: string };
  error?: Error;
  onRun?: () => void;
  smartCase?: boolean;
  paths?: string[];
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

function fakeSmartCase(patterns: readonly string[]): boolean {
  return patterns.every((pattern) => {
    const syntaxStripped = pattern
      .replace(/\\[pP]\{[^}]*\}/g, "")
      .replace(/\\[A-Z]/g, "")
      .replace(/\(\?P<[^>]*>/g, "");
    return syntaxStripped === syntaxStripped.toLowerCase();
  });
}

function fakePredicate(patterns: readonly string[], modes: SearchModes, word: boolean): LinePredicate {
  const matchers = patterns.map((pattern) => {
    let source = modes.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    if (word) source = `\\b(?:${source})\\b`;
    return new RegExp(source, modes.ignoreCase ? "iu" : "u");
  });
  return async (lines) => lines.map((line) => {
    const text = line.toString("utf8").replace(/\r?\n$/, "");
    return matchers.some((matcher) => matcher.test(text));
  });
}

function fakeBackend(options: FakeOptions = {}) {
  const calls: { path: string; args: string[] }[] = [];
  const modeCalls: { patterns: readonly string[]; literal: boolean; explicit: boolean | undefined }[] = [];
  const backend: GrepBackend = {
    async runRg(path, args, _signal, onLine) {
      calls.push({ path, args });
      options.onRun?.();
      if (options.error) throw options.error;
      if (args.includes("--quiet")) {
        return { code: 1, stderr: "", ...options.validation, stopped: false };
      }
      for (const line of options.lines ?? []) {
        if (!await onLine(line)) return { code: null, stderr: options.stderr ?? "", stopped: true };
      }
      return {
        code: options.code === undefined ? 0 : options.code,
        stderr: options.stderr ?? "",
        stopped: false,
      };
    },
    async runRgPaths(_path, _args, _signal, onPath) {
      for (const path of options.paths ?? []) {
        if (!await onPath(path)) return { code: null, stderr: "", stopped: true };
      }
      return { code: options.paths?.length ? 0 : 1, stderr: "", stopped: false };
    },
    async resolveIgnoreCase(_path, patterns, modes, explicit) {
      modeCalls.push({ patterns, literal: modes.literal, explicit });
      return explicit ?? options.smartCase ?? fakeSmartCase(patterns);
    },
    async validatePatterns() {},
    createLinePredicate(_path, patterns, modes, word) {
      return fakePredicate(patterns, modes, word);
    },
  };
  return { backend, calls, modeCalls };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  tool.execute("0", params, signal, undefined);

test("grep guidance distinguishes literal code searches from regex and array alternatives", () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), {});
  assert.match(tool.promptGuidelines.join("\n"), /literal:true.*pi\.on\(.*pattern array.*literal alternatives/);
  assert.match(JSON.stringify(tool.parameters.properties.pattern), /use an array for alternatives/);
  assert.match(JSON.stringify(tool.parameters.properties.literal), /entire input literally/);
});

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
      for (const option of ["noIgnore", "follow", "pcre2", "multiline"] as const) {
        assert.equal(tool.parameters.properties[option].type, "boolean");
      }
      const result = await call(tool, {
        pattern: "alpha",
      });
      const output = text(result);
      assert.match(output, /a\.ts · 2 matches/);
      assert.match(output, /b\.ts · 1 match/);
      assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta")}│alpha beta`));
      assert.match(output, /3#[0-9A-Z]+│alpha only/);
      assert.deepEqual(fake.calls[0], {
        path: rgPath,
        args: ["--no-config", "--color=never", "--no-crlf", "--engine=default", "--no-multiline", "--ignore-case", "--fixed-strings", "--json", "--line-number", "--hidden", "-e", "alpha", "--", dir],
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
      const fake = fakeBackend({
        lines: [rgMatch(a, 1, "Foo a.b\n"), rgMatch(b, 1, "foo a.b\n")],
        paths: [a, b],
      });

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
        "--no-config",
        "--color=never",
        "--no-crlf",
        "--engine=default",
        "--no-multiline",
        "--ignore-case",
        "--fixed-strings",
        "--word-regexp",
        "--json",
        "--line-number",
        "--hidden",
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

test("aligns TUI line numbers across files to the widest result", () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), fakeBackend().backend);
  const raw = [
    "a.ts · 2 matches",
    "99#ABCD│  alpha",
    "100#ABCD│    beta",
    "b.ts · 1 match",
    "7#ABCD│gamma",
  ].join("\n");
  const theme = { fg: (_color: string, value: string) => value };
  const rendered = tool.renderResult!(
    { content: [{ type: "text", text: raw }] },
    { isPartial: false, expanded: true },
    theme,
    {},
  ).render(80).map((line: string) => line.trimEnd());
  const rows = rendered.filter((line: string) => /^\s+\d+:/.test(line));
  assert.deepEqual(rows.map((line: string) => line.indexOf(":")), [6, 6, 6]);
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
    assert.match(text(result), /Invalid regex; searched the pattern as literal text/);
    for (const params of [
      { pattern: ["plain", "broken("] },
      { pattern: "broken(", excludePattern: "^\\s*//" },
      { pattern: "plain", excludePattern: "broken(" },
    ]) {
      await assert.rejects(call(fallback, params), /Invalid regex in compound query; automatic literal fallback is disabled/);
    }
    await call(tool, { pattern: "value.*" });
    await call(tool, { pattern: "plain", literal: false });
    await call(tool, { pattern: "value.*", literal: true });

    assert.deepEqual(
      [...invalid.calls, ...valid.calls].filter(({ args }) => !args.includes("--quiet"))
        .map(({ args }) => args.includes("--fixed-strings")),
      [true, false, false, true],
    );
    assert.equal(valid.calls.filter(({ args }) => args.includes("--quiet")).length, 2);
    assert.deepEqual(invalid.calls[0].args, [
      "--no-config", "--color=never", "--no-crlf", "--engine=default", "--no-multiline",
      "--quiet", "-e", "queueTool(", "--", "-",
    ]);

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

    const mixed = fakeBackend();
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
      [[true, false], [false, true], [true, false], [false, true], [true, false], [true, false]],
    );
  });
});

test("bounds rg predicate fanout for matchMode all", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    await assert.rejects(
      call(tool, {
        pattern: Array.from({ length: 17 }, (_, index) => `pattern${index}`),
        matchMode: "all",
      }),
      /supports at most 16 patterns/,
    );
    assert.equal(fake.calls.length, 0);
  });
});

test("rejects empty patterns while allowing wildcard, literal, and empty-line searches", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);

    for (const pattern of ["", "  ", []]) {
      await assert.rejects(call(tool, { pattern }), /pattern (?:is required|must not be empty)/);
    }
    assert.equal(fake.calls.length, 0);
    for (const pattern of [".*", "^.+$", ".?"]) {
      assert.equal(text(await call(tool, { pattern })), "No matches found");
    }

    assert.equal(text(await call(tool, { pattern: ".*", literal: true })), "No matches found");
    assert.equal(text(await call(tool, { pattern: "^$" })), "No matches found");
    assert.equal(fake.calls.filter(({ args }) => !args.includes("--quiet")).length, 5);
    assert.equal(fake.calls.filter(({ args }) => args.includes("--quiet")).length, 4);
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


test("rejects calls aborted before or during rg execution", async () => {
  await withDir(async (dir) => {
    const alreadyAborted = fakeBackend();
    const first = new AbortController();
    first.abort();
    await assert.rejects(
      call(
        makeGrepOverrideWithBackend(dir, alreadyAborted.backend),
        { pattern: ["x", "y"] },
        first.signal,
      ),
      /Operation aborted/,
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


test("AND searches gate on the first pattern and amortize filtering across bounded batches", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.ts");
    const fake = fakeBackend({
      lines: Array.from({ length: 4097 }, (_, index) => rgMatch(file, index + 1, "foo bar\n")),
    });
    const batches: number[][] = [];
    const filteredPatterns: string[][] = [];
    fake.backend.createLinePredicate = (_path, patterns) => {
      filteredPatterns.push([...patterns]);
      const sizes: number[] = [];
      batches.push(sizes);
      return async (candidates) => {
        sizes.push(candidates.length);
        return candidates.map(() => patterns[0] === "bar");
      };
    };

    const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
      pattern: ["foo", "bar"],
      matchMode: "all",
      excludePattern: "skip",
      literal: true,
      ignoreCase: false,
      outputMode: "count",
      limit: 5000,
    });
    assert.match(text(result), /fixture\.ts: 4097/);
    assert.deepEqual(batches, [[4096, 1], [4096, 1]]);
    assert.deepEqual(filteredPatterns, [["bar"], ["skip"]]);
    const args = fake.calls[0].args;
    assert.deepEqual(args.flatMap((arg, index) => args[index - 1] === "-e" ? [arg] : []), ["foo"]);
  });
});

test("large candidate lines flush before the batch line-count limit", async () => {
  await withDir(async (dir) => {
    const line = `foo${"x".repeat(600_000)}\n`;
    const fake = fakeBackend({
      lines: Array.from({ length: 3 }, (_, index) => rgMatch(join(dir, "large.ts"), index + 1, line)),
    });
    const sizes: number[] = [];
    fake.backend.createLinePredicate = () => async (candidates) => {
      sizes.push(candidates.length);
      return candidates.map(() => true);
    };
    const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
      pattern: "foo", excludePattern: "foo", literal: true, ignoreCase: false,
    });
    assert.equal(text(result), "No matches found");
    assert.deepEqual(sizes, [2, 1]);
  });
});

test("grep rejects malformed UTF-8 and NUL bytes instead of hashing binary text", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const cases = [
        { name: "invalid.txt", bytes: Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]), error: /UNSUPPORTED_ENCODING/ },
        { name: "nul.txt", bytes: Buffer.from([0x61, 0x00, 0x62]), error: /UNSUPPORTED_TEXT/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, fixture.name);
        await writeFile(file, fixture.bytes);
        const fake = fakeBackend({ lines: [rgMatch(file, 1, "a\n")], paths: [file] });
        await assert.rejects(call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "a", path: file }), fixture.error);
        assert.deepEqual(await readFile(file), fixture.bytes);
      }
    }),
  );
});

test("partial searches retain matches and surface stderr across output modes", async () => {
  await withDir(async dir => {
    const file = join(dir, "found.txt");
    await writeFile(file, "needle\n");
    for (const outputMode of ["content", "files", "count"]) {
      for (const limit of [1, 10]) {
        const fake = fakeBackend({ lines: [rgMatch(file, 1, "needle\n")], code: 2, stderr: "unreadable.txt: Permission denied" });
        const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "needle", outputMode, limit });
        assert.match(text(result), /found\.txt/);
        assert.match(text(result), /Search incomplete; results and counts cover only confirmed matches/);
        assert.match(text(result), /unreadable\.txt: Permission denied/);
        assert.equal(result.details.incomplete, true);
      }
    }
    const fake = fakeBackend({ code: 2, stderr: "Permission denied" });
    await assert.rejects(call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "needle" }), /No matches confirmed.*Search incomplete/s);
  });
});

test("failed result reads report incomplete coverage while retaining readable files", async () => {
  await withDir(async dir => {
    const good = join(dir, "good.txt");
    const gone = join(dir, "gone.txt");
    await writeFile(good, "needle\n");
    await writeFile(gone, "needle\n");
    const fake = fakeBackend({ lines: [rgMatch(gone, 1, "needle\n"), rgMatch(good, 1, "needle\n")] });
    const result = await call(makeGrepOverrideWithBackend(dir, { ...fake.backend, runRg: async (...args) => {
      const result = await fake.backend.runRg(...args);
      await rm(gone);
      return result;
    } }), { pattern: "needle" });
    assert.match(text(result), /good\.txt · 1 match/);
    assert.doesNotMatch(text(result), /gone\.txt · 1 match/);
    assert.match(text(result), /Search incomplete/);
    assert.match(text(result), /Could not read.*gone\.txt/);
  });
});

test("complex searches report listing errors but reject incomplete exclusion scans", async () => {
  await withDir(async dir => {
    const file = join(dir, "fixture.txt");
    await writeFile(file, "needle\n");
    const event = JSON.stringify({ type: "match", data: { path: { text: file }, line_number: 1, lines: { text: "needle\n" }, submatches: [{ start: 0, end: 6 }] } });
    const fake = fakeBackend({ paths: [file], lines: [event] });
    const listing = await call(makeGrepOverrideWithBackend(dir, { ...fake.backend, runRgPaths: async (...args) => {
      const result = await fake.backend.runRgPaths(...args);
      return { ...result, code: 2, stderr: "directory: Permission denied" };
    } }), { pattern: "needle", multiline: true });
    assert.match(text(listing), /1#[0-9A-Z]+│needle/);
    assert.match(text(listing), /Search incomplete/);
    const tool = makeGrepOverrideWithBackend(dir, { ...fake.backend, runRg: async (...args) => {
      const result = await fake.backend.runRg(...args);
      return args[1].includes("exclude") ? { ...result, code: 2, stderr: "exclusion scan failed" } : result;
    } });
    await assert.rejects(call(tool, { pattern: "needle", excludePattern: "exclude", multiline: true }), /exclusion scan failed/);
  });
});

/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { scopeArgs, type SearchRequest } from "./grep-search.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";

type FakeOptions = {
  lines?: string[];
  code?: number | null;
  stderr?: string;
  validation?: Awaited<ReturnType<GrepBackend["probeRegex"]>>;
  error?: Error;
  onRun?: () => void;
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

function fakeBackend(options: FakeOptions = {}) {
  const calls: { path: string; request: SearchRequest }[] = [];
  const probes: Parameters<GrepBackend["probeRegex"]>[] = [];
  const backend: GrepBackend = {
    async search(path, request, _signal, onLine) {
      calls.push({ path, request });
      options.onRun?.();
      if (options.error) throw options.error;
      for (const line of options.lines ?? []) {
        if (!(await onLine(line)))
          return { code: null, stderr: options.stderr ?? "", stopped: true };
      }
      return {
        code: options.code === undefined ? 0 : options.code,
        stderr: options.stderr ?? "",
        stopped: false,
      };
    },
    async runRgPaths(_path, _args, _signal, onPath) {
      for (const path of options.paths ?? []) {
        if (!(await onPath(path))) return { code: null, stderr: "", stopped: true };
      }
      return { code: options.paths?.length ? 0 : 1, stderr: "", stopped: false };
    },
    async resolveIgnoreCase(_path, patterns, _modes, explicit) {
      return explicit ?? fakeSmartCase(patterns);
    },
    async probeRegex(...args) {
      probes.push(args);
      return { code: 1, stderr: "", ...options.validation };
    },
  };
  return { backend, calls, probes };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  callTool(tool, params, { toolCallId: "0", signal });

test("grep guidance covers query syntax, search scope, and edit anchors", () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, {});
  for (const [topic, terms] of [
    ["exact text", [/literal:true for exact text/, /names/, /paths/, /code snippets/]],
    [
      "intentional Rust regex",
      [
        /literal:false only for intentional ripgrep \(Rust\) regex/,
        /no lookaround or backreferences/,
      ],
    ],
    ["pattern alternatives", [/pattern array/, /alternatives/, /\|/]],
    ["edit context", [/context:3-5/, /code to edit/]],
    [
      "path and glob",
      [/omit path/, /working directory/, /never pass ""/, /glob.*filename wildcards/],
    ],
    ["multiline", [/multiline:true/, /cross-line/]],
    ["edit anchors", [/grep anchors/, /directly into edit/, /full line/, /partial preview/]],
  ] as const) {
    assert.ok(
      tool.promptGuidelines.some((rule) => terms.every((term) => term.test(rule))),
      `grep guideline missing ${topic}`,
    );
  }
  assert.ok(tool.promptGuidelines.every((rule) => rule.includes("grep")));

  const params = tool.parameters.properties;
  const description = (field: keyof typeof params) => {
    const value: unknown = Reflect.get(params[field], "description");
    assert.ok(typeof value === "string", `${field} needs a description`);
    return value;
  };
  assert.match(description("pattern"), /ripgrep.*Rust/);
  assert.match(description("pattern"), /not JavaScript/);
  assert.match(description("pattern"), /\^ and \$.*line boundaries/);
  assert.match(description("literal"), /true:.*match the text exactly.*regex punctuation/);
  assert.match(description("literal"), /false:.*ripgrep Rust regex.*foo\(0\).*foo0/);
  assert.match(description("path"), /omit.*working directory/);
  assert.match(description("path"), /Wildcards are not expanded.*glob/);
  assert.match(description("multiline"), /\. wildcard does not match newlines.*\\n or \(\?s\)/);
  assert.match(description("ignoreCase"), /omitted.*smart-case.*whole query/);
});

test("configured grep defaults drive descriptions, match limits, and context", async () =>
  withDir(async (dir) => {
    const file = join(dir, "configured.txt");
    const lines = [
      "before one",
      "needle one",
      "after one",
      "gap",
      "before two",
      "needle two",
      "after two",
    ];
    await writeFile(file, `${lines.join("\n")}\n`);
    const fake = fakeBackend({
      lines: [rgMatch(file, 2, "needle one\n"), rgMatch(file, 6, "needle two\n")],
    });
    const config = { ...DEFAULT_CONFIG, grep: { defaultLimit: 1, defaultContext: 2 } };
    const tool = makeGrepOverrideWithBackend(dir, config, fake.backend);
    for (const [field, expected] of [
      ["limit", 1],
      ["context", 2],
    ] as const) {
      const description: unknown = Reflect.get(tool.parameters.properties[field], "description");
      assert.ok(typeof description === "string");
      assert.match(description, new RegExp(`default ${expected}\\)`));
    }
    const expectedRow = (line: number) =>
      `${line}#${computeLineHash(line, lines[line - 1], config.hashLen)}│${lines[line - 1]}`;
    const rows = (result: unknown) =>
      text(result)
        .split("\n")
        .filter((line) => /^\d+#/.test(line));

    const defaults = await call(tool, { path: file, pattern: "needle", literal: true });
    assert.deepEqual(rows(defaults), [1, 2, 3, 4].map(expectedRow));
    assert.match(text(defaults), /configured\.txt · 1 match\n/);
    assert.match(text(defaults), /1 matches limit reached/);

    const explicit = await call(tool, {
      path: file,
      pattern: "needle",
      literal: true,
      limit: 2,
      context: 0,
    });
    assert.deepEqual(rows(explicit), [2, 6].map(expectedRow));
    assert.match(text(explicit), /configured\.txt · 2 matches\n/);
  }));

test("grep exposes nine parameters and rejects only the six removed fields", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
      "context",
      "glob",
      "ignoreCase",
      "limit",
      "literal",
      "multiline",
      "outputMode",
      "path",
      "pattern",
    ]);
    assert.equal(
      "additionalProperties" in tool.parameters && tool.parameters.additionalProperties,
      false,
    );

    const removed = {
      matchMode: "all",
      excludePattern: "skip",
      wordMatch: true,
      pcre2: true,
      follow: true,
      noIgnore: true,
    };
    for (const [key, value] of Object.entries(removed)) {
      for (const input of [value, false, null]) {
        await assert.rejects(
          call(tool, { literal: true, pattern: "needle", [key]: input }),
          (error: Error) => error.message.includes(`- ${key}: schema is false`),
        );
      }
    }
    await assert.rejects(
      call(tool, { literal: true, pattern: "needle", follow: false, noIgnore: null }),
      (error: Error) =>
        error.message.includes("- follow: schema is false") &&
        error.message.includes("- noIgnore: schema is false"),
    );
    assert.equal(fake.calls.length, 0);
  });
});

test("grep limit accepts only positive integers", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const limitSchema = tool.parameters.properties.limit;
    assert.equal(limitSchema.type, "number");
    assert.equal("minimum" in limitSchema ? limitSchema.minimum : undefined, 1);
    assert.equal("multipleOf" in limitSchema ? limitSchema.multipleOf : undefined, 1);
    for (const limit of [0, -3, 0.5, 2.5]) {
      await assert.rejects(
        call(tool, { literal: true, pattern: "needle", limit }),
        /Validation failed for tool "grep":\n {2}- limit: /,
      );
    }
    assert.equal(fake.calls.length, 0);
    await assert.doesNotReject(call(tool, { literal: true, pattern: "needle", limit: 1 }));
  });
});

test("grep schema rejects empty search inputs and fractional context", async () =>
  withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const invalidArgs = [
      { literal: true, pattern: "" },
      { literal: true, pattern: [] },
      { literal: true, pattern: ["ok", ""] },
      { literal: true, pattern: "needle", path: "" },
      { literal: true, pattern: "needle", path: [] },
      { literal: true, pattern: "needle", glob: "" },
      { literal: true, pattern: "needle", glob: [] },
      { literal: true, pattern: "needle", context: 1.5 },
      { literal: true, pattern: "needle", limit: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const args of invalidArgs) {
      await assert.rejects(
        call(tool, args),
        /Validation failed for tool "grep"/,
        JSON.stringify(args),
      );
    }
    await assert.rejects(
      call(tool, { literal: true, pattern: "needle", context: 1.5 }),
      /Validation failed for tool "grep":\n {2}- context: /,
    );
    assert.equal(fake.calls.length, 0);
  }));

test("case and multiline options select only their matching ripgrep flags", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.ts");
    await writeFile(file, "FOO\nfoo\n");
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    await call(tool, {
      path: file,
      pattern: "FOO",
      ignoreCase: true,
      multiline: true,
      literal: true,
    });
    assert.ok(fake.calls[0].request.matcher.includes("--ignore-case"));
    assert.ok(fake.calls[0].request.matcher.includes("--multiline"));
    await call(tool, {
      literal: true,
      path: file,
      pattern: "foo",
      ignoreCase: false,
      multiline: false,
    });
    assert.ok(fake.calls.at(-1)?.request.matcher.includes("--case-sensitive"));
    assert.ok(fake.calls.at(-1)?.request.matcher.includes("--no-multiline"));
  });
});

test("grep points wildcard paths to glob without changing ordinary missing-path errors", async () => {
  await withDir(async (dir) => {
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fakeBackend().backend);
    await assert.rejects(
      call(tool, { literal: true, pattern: "value", path: "src/fusion-card*" }),
      /Path not found: .*fusion-card\*.*Use an existing directory as path and a filename wildcard as glob/,
    );
    await assert.rejects(
      call(tool, { literal: true, pattern: "value", path: "src/missing" }),
      (error: Error) =>
        error.message.endsWith("src\\missing") || error.message.endsWith("src/missing"),
    );
  });
});

test("formats parsed rg matches with full-line hash anchors", async () => {
  await withDir(async (dir) => {
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

    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    assert.deepEqual(tool.parameters.required, ["pattern", "literal"]);
    const result = await call(tool, { literal: true, pattern: "alpha" });
    const output = text(result);
    assert.match(output, /a\.ts · 2 matches/);
    assert.match(output, /b\.ts · 1 match/);
    assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta", 4)}│alpha beta`));
    assert.match(output, /3#[0-9A-Z]+│alpha only/);
    assert.deepEqual(fake.calls[0], {
      path: rgPath,
      request: {
        matcher: [
          "--no-config",
          "--color=never",
          "--no-crlf",
          "--engine=default",
          "--no-multiline",
          "--ignore-case",
          "--fixed-strings",
          "--json",
          "--line-number",
          "-e",
          "alpha",
        ],
        scope: { globs: [], noIgnore: false, follow: false, searchPaths: [dir] },
      },
    });
  });
});

test("grep rejects a file changed between a match and anchor formatting", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "needle\nother\n");
    const fake = fakeBackend({ lines: [rgMatch(file, 1, "needle\n")] });
    const backend: GrepBackend = {
      ...fake.backend,
      async search(...args) {
        const result = await fake.backend.search(...args);
        await writeFile(file, "NOT_THE_MATCH\nneedle\n");
        return result;
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
        literal: true,
        pattern: "needle",
      }),
      /File changed during search/,
    );
  });
});

test("grep rejects matches missing from the current file before anchoring context", async () =>
  withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "line1\nline2\nline3\nneedle\nline5\n");
    const fake = fakeBackend({ lines: [rgMatch(file, 5, "needle\n")] });
    const backend: GrepBackend = {
      ...fake.backend,
      async search(...args) {
        await writeFile(file, "line1\nline2\nline3\n");
        return fake.backend.search(...args);
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
        literal: true,
        pattern: "needle",
        context: 2,
      }),
      /File changed during search/,
    );
  }));

test("multiline grep rejects a zero-width match beyond the current EOF", async () =>
  withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\nfive\n");
    const fake = fakeBackend({
      lines: [
        JSON.stringify({
          type: "match",
          data: {
            path: { text: file },
            line_number: 5,
            lines: { text: "" },
            submatches: [{ start: 0, end: 0 }],
          },
        }),
      ],
    });
    const backend: GrepBackend = {
      ...fake.backend,
      async search(...args) {
        await writeFile(file, "one\ntwo\n");
        return fake.backend.search(...args);
      },
    };
    for (const outputMode of ["content", "files", "count"]) {
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
          pattern: "(?m)^",
          multiline: true,
          literal: false,
          outputMode,
        }),
        /File changed during search/,
      );
    }
  }));

test("multiline grep rejects spans beyond a truncated file", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "alpha\n");
    const fake = fakeBackend({
      lines: [
        JSON.stringify({
          type: "match",
          data: {
            path: { text: file },
            line_number: 1,
            lines: { text: "alpha\nbeta\n" },
            submatches: [{ start: 0, end: 10 }],
          },
        }),
      ],
    });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
        pattern: "alpha\\nbeta",
        path: file,
        literal: false,
        multiline: true,
      }),
      /File changed during search/,
    );
  });
});
test("grep rejects changed context even when the matched line stays the same", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "needle\nold context\n");
    const fake = fakeBackend({ lines: [rgMatch(file, 1, "needle\n")] });
    const backend: GrepBackend = {
      ...fake.backend,
      async search(...args) {
        const result = await fake.backend.search(...args);
        await writeFile(file, "needle\nnew context\n");
        return result;
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
        literal: true,
        pattern: "needle",
        context: 1,
      }),
      /File changed during search/,
    );
  });
});

test("grep in a subdirectory returns a path that edits the matching file", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "src"));
    const original = "export const status = 1;\n";
    const rootFile = join(dir, "status.ts");
    const matchedFile = join(dir, "src", "status.ts");
    await writeFile(rootFile, original);
    await writeFile(matchedFile, original);
    const fake = fakeBackend({ lines: [rgMatch(matchedFile, 1, original)] });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "status",
      path: "src",
    });
    const output = text(result);
    const displayPath = output.split(" · ")[0];
    const edit: any = makeEditOverride(dir, DEFAULT_CONFIG);
    await call(edit, {
      path: displayPath,
      edits: [
        {
          op: "replace",
          anchor: `1#${computeLineHash(1, original.trimEnd(), 4)}`,
          body: ["export const status = 2;"],
        },
      ],
    });
    assert.equal(await readFile(matchedFile, "utf-8"), "export const status = 2;\n");
    assert.equal(await readFile(rootFile, "utf-8"), original);
  });
});

test("context preserves logical CRLF anchors around a matched line", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.ts");
    await writeFile(
      file,
      "outside-before\r\nalpha beta drop\r\nbefore survivor\r\nalpha beta\r\nafter survivor\r\nalpha only\r\noutside-after\r\n",
    );
    const fake = fakeBackend({ lines: [rgMatch(file, 4, "alpha beta\n")] });

    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const contextSchema: any = tool.parameters.properties.context;
    assert.equal(contextSchema.type, "number");
    assert.equal(contextSchema.minimum, 0);
    assert.equal(contextSchema.maximum, 20);
    assert.equal(contextSchema.multipleOf, 1);
    const result = await call(tool, { pattern: "beta$", literal: false, context: 1 });
    assert.equal(
      text(result),
      [
        "a.ts · 1 match",
        `3#${computeLineHash(3, "before survivor", 4)}│before survivor`,
        `4#${computeLineHash(4, "alpha beta", 4)}│alpha beta`,
        `5#${computeLineHash(5, "after survivor", 4)}│after survivor`,
      ].join("\n"),
    );
  });
});

test("passes output flags and formats files and counts", async () => {
  await withDir(async (dir) => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await writeFile(a, "Foo a.b\n");
    await writeFile(b, "foo a.b\n");
    const fake = fakeBackend({
      lines: [rgMatch(a, 1, "Foo a.b\n"), rgMatch(b, 1, "foo a.b\n")],
      paths: [a, b],
    });

    const files = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: ["Foo", "a.b"],
      path: ["a.ts", "b.ts"],
      glob: ["*.ts", "!**/*.test.ts"],
      literal: true,
      outputMode: "files",
    });
    assert.equal(text(files), "a.ts\nb.ts");
    assert.deepEqual(fake.calls[0].request.matcher, [
      "--no-config",
      "--color=never",
      "--no-crlf",
      "--engine=default",
      "--no-multiline",
      "--case-sensitive",
      "--fixed-strings",
      "--json",
      "--line-number",
      "-e",
      "Foo",
      "-e",
      "a.b",
    ]);
    assert.deepEqual(scopeArgs(fake.calls[0].request.scope), [
      "--hidden",
      "--glob",
      "*.ts",
      "--glob",
      "!**/*.test.ts",
    ]);
    assert.deepEqual(fake.calls[0].request.scope.searchPaths, [a, b]);

    const count = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "foo",
      outputMode: "count",
    });
    assert.equal(text(count), "a.ts: 1\nb.ts: 1\nTotal: 2 matches in 2 files");
  });
});

test("aligns TUI line numbers across files to the widest result", () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, fakeBackend().backend);
  const raw = [
    "a.ts · 2 matches",
    "99#ABCD│  alpha",
    "100#ABCD│    beta",
    "b.ts · 1 match",
    "7#ABCD│gamma",
  ].join("\n");
  const theme = { fg: (_color: string, value: string) => value };
  const rendered = tool.renderResult!(
    { content: [{ type: "text", text: raw }], details: undefined },
    { isPartial: false, expanded: true },
    theme as any,
    {} as any,
  )
    .render(80)
    .map((line: string) => line.trimEnd());
  const rows = rendered.filter((line: string) => /^\s+\d+:/.test(line));
  assert.deepEqual(
    rows.map((line: string) => line.indexOf(":")),
    [6, 6, 6],
  );
});

test("limit counts matched lines and stops the fake runner", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.ts");
    await writeFile(file, "alpha beta\nalpha only\nalpha later\n");
    const fake = fakeBackend({
      lines: [
        rgMatch(file, 1, "alpha beta\n"),
        rgMatch(file, 2, "alpha only\n"),
        rgMatch(file, 3, "alpha later\n"),
      ],
    });

    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "alpha",
      limit: 1,
    });
    assert.match(text(result), /1#[0-9A-Z]+│alpha beta/);
    assert.match(
      text(result),
      /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/,
    );
  });
});

test("grep requires literal before invoking the backend", async () => {
  const fake = fakeBackend();
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, fake.backend);
  await assert.rejects(
    callTool(tool, { pattern: "needle" }),
    /Validation failed for tool "grep":\n {2}- literal: /,
  );
  assert.equal(fake.probes.length, 0);
  assert.equal(fake.calls.length, 0);
});

test("literal grep searches regex punctuation exactly without a regex probe", async () =>
  withDir(async (dir) => {
    const file = join(dir, "literal.txt");
    await writeFile(file, "foo(0)\n");
    const fake = fakeBackend({
      lines: [rgMatch(file, 1, "foo(0)\n")],
      validation: { code: 2, stderr: "regex probe must not run" },
    });
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const result = await call(tool, { pattern: "foo(0)", literal: true });
    assert.match(text(result), /1#[0-9A-Z]+│foo\(0\)/);
    assert.deepEqual(fake.probes, []);
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].request.matcher.includes("--fixed-strings"));
    assert.ok(fake.calls[0].request.matcher.includes("foo(0)"));
  }));

test("regex grep accepts successful and no-match probe exit codes before searching", async () =>
  withDir(async (dir) => {
    const file = join(dir, "regex.txt");
    await writeFile(file, "foo0\n");
    for (const code of [0, 1]) {
      const fake = fakeBackend({
        lines: [rgMatch(file, 1, "foo0\n")],
        validation: { code, stderr: "" },
      });
      const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
      const result = await call(tool, { pattern: "foo(0)", literal: false });
      assert.match(text(result), /1#[0-9A-Z]+│foo0/);
      assert.deepEqual(fake.probes, [[rgPath, ["foo(0)"], false, undefined]]);
      assert.equal(fake.calls.length, 1);
      assert.ok(!fake.calls[0].request.matcher.includes("--fixed-strings"));
    }
  }));

test("invalid regex strings and arrays fail before search with explicit literal guidance", async () =>
  withDir(async (dir) => {
    for (const pattern of ["streamSimple(", ["plain", "streamSimple("]]) {
      const fake = fakeBackend({
        validation: { code: 2, stderr: "regex parse error:\nerror: unclosed group" },
      });
      const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
      await assert.rejects(
        call(tool, { pattern, literal: false }),
        /regex parse error:[\s\S]*set literal:true to search the text exactly\.$/,
      );
      assert.equal(fake.probes.length, 1);
      assert.deepEqual(fake.probes[0][1], typeof pattern === "string" ? [pattern] : pattern);
      assert.equal(fake.calls.length, 0);
    }
  }));

test("unsupported regex syntax reports the Rust dialect hint before search", async () =>
  withDir(async (dir) => {
    for (const pattern of ["foo(?=bar)", "(foo)\\1", ["plain", "foo(?=bar)"]]) {
      const fake = fakeBackend({
        validation: { code: 2, stderr: "regex parse error:\nerror: unsupported syntax" },
      });
      const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
      await assert.rejects(
        call(tool, { pattern, literal: false }),
        /regex parse error:[\s\S]*no lookaround or backreferences; rewrite the pattern, or use replace/,
      );
      assert.equal(fake.probes.length, 1);
      assert.equal(fake.calls.length, 0);
    }
  }));

test("regex probe failures retain diagnostics and never search", async () =>
  withDir(async (dir) => {
    for (const [validation, message] of [
      [{ code: 2, stderr: "Permission denied" }, "Permission denied"],
      [{ code: 3, stderr: "" }, "ripgrep exited with code 3"],
    ] as const) {
      const fake = fakeBackend({ validation });
      const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
      await assert.rejects(call(tool, { pattern: "value.*", literal: false }), { message });
      assert.equal(fake.probes.length, 1);
      assert.equal(fake.calls.length, 0);
    }
  }));

test("uses smart-case across the entire OR pattern array", async () => {
  await withDir(async (dir) => {
    const target = join(dir, "case.ts");
    await writeFile(target, "FOO alpha\n");

    const lower = fakeBackend({ lines: [rgMatch(target, 1, "FOO alpha\n")] });
    const lowerResult = await call(
      makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, lower.backend),
      { literal: true, pattern: ["foo", "alpha"] },
    );
    assert.match(text(lowerResult), /FOO alpha/);

    const mixed = fakeBackend();
    const mixedResult = await call(
      makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, mixed.backend),
      { literal: true, pattern: ["Foo", "alpha"] },
    );
    assert.equal(text(mixedResult), "No matches found");

    const flags = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, flags.backend);
    await call(tool, { literal: true, pattern: "lower" });
    await call(tool, { literal: true, pattern: "Upper" });
    await call(tool, { pattern: "foo\\S*", literal: false });
    assert.deepEqual(
      flags.calls.map(({ request }) => [
        request.matcher.includes("--ignore-case"),
        request.matcher.includes("--case-sensitive"),
      ]),
      [
        [true, false],
        [false, true],
        [true, false],
      ],
    );
  });
});

test("OR pattern arrays are not limited by the former AND filter", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const patterns = Array.from({ length: 17 }, (_, index) => `pattern${index}`);
    assert.equal(text(await call(tool, { literal: true, pattern: patterns })), "No matches found");
    assert.deepEqual(
      fake.calls[0].request.matcher.flatMap((arg, index, args) =>
        args[index - 1] === "-e" ? [arg] : [],
      ),
      patterns,
    );
  });
});

test("rejects empty patterns while allowing wildcard, literal, and empty-line searches", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);

    for (const pattern of ["", [], ["valid", ""]]) {
      await assert.rejects(
        call(tool, { pattern, literal: true }),
        /Validation failed for tool "grep"/,
      );
    }
    assert.equal(fake.calls.length, 0);
    for (const pattern of [".*", "^.+$", ".?"]) {
      assert.equal(text(await call(tool, { pattern, literal: false })), "No matches found");
    }

    assert.equal(text(await call(tool, { pattern: ".*", literal: true })), "No matches found");
    assert.equal(text(await call(tool, { pattern: "^$", literal: false })), "No matches found");
    assert.equal(fake.calls.length, 5);
    assert.equal(fake.probes.length, 4);
  });
});

test("grep accepts nonempty whitespace literals", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    for (const pattern of ["  ", "\t", ["word", " "]]) {
      assert.equal(text(await call(tool, { pattern, literal: true })), "No matches found");
    }
    assert.equal(fake.calls.length, 3);
  });
});

test("reports empty output and ripgrep execution failures", async () => {
  await withDir(async (dir) => {
    const empty = fakeBackend({ code: 1 });
    assert.equal(
      text(
        await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, empty.backend), {
          literal: true,
          pattern: "missing",
        }),
      ),
      "No matches found",
    );

    const failed = fakeBackend({ code: 2, stderr: "bad regex" });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, failed.backend), {
        pattern: "[",
        literal: false,
      }),
      /bad regex/,
    );

    const rejected = fakeBackend({ error: new Error("spawn failed") });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, rejected.backend), {
        literal: true,
        pattern: "x",
      }),
      /spawn failed/,
    );
  });
});

test("rejects calls aborted before or during rg execution", async () => {
  await withDir(async (dir) => {
    const alreadyAborted = fakeBackend();
    const first = new AbortController();
    first.abort();
    await assert.rejects(
      call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, alreadyAborted.backend),
        { literal: true, pattern: ["x", "y"] },
        first.signal,
      ),
      /Operation aborted/,
    );

    const controller = new AbortController();
    const interrupted = fakeBackend({ onRun: () => controller.abort() });
    await assert.rejects(
      call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, interrupted.backend),
        { literal: true, pattern: ["x", "y"] },
        controller.signal,
      ),
      /Operation aborted/,
    );
  });
});

test("OR patterns count each matched line once", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.ts");
    await writeFile(file, "foo bar\n".repeat(4097));
    const fake = fakeBackend({
      lines: Array.from({ length: 4097 }, (_, index) => rgMatch(file, index + 1, "foo bar\n")),
    });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: ["foo", "bar"],
      literal: true,
      outputMode: "count",
      limit: 5000,
    });
    assert.match(text(result), /fixture\.ts: 4097/);
    assert.deepEqual(
      fake.calls[0].request.matcher.flatMap((arg, index, args) =>
        args[index - 1] === "-e" ? [arg] : [],
      ),
      ["foo", "bar"],
    );
  });
});

test("long candidate lines remain countable without content previews", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "large.ts");
    const line = `foo${"x".repeat(600_000)}\n`;
    await writeFile(file, line.repeat(3));
    const fake = fakeBackend({
      lines: Array.from({ length: 3 }, (_, index) => rgMatch(file, index + 1, line)),
    });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: "foo",
      literal: true,
      outputMode: "count",
    });
    assert.match(text(result), /large\.ts: 3/);
    assert.equal(fake.calls.length, 1);
  });
});

test("grep previews invalid UTF-8 without anchors and skips NUL hits that require snapshots", async () => {
  await withDir(async (dir) => {
    const invalid = join(dir, "invalid.txt");
    const source = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]);
    await writeFile(invalid, source);
    const fake = fakeBackend({ lines: [rgMatch(invalid, 1, "a\n")], paths: [invalid] });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "a",
      path: invalid,
      context: 1,
    });
    assert.match(text(result), /1│a\n2│�\(/);
    assert.match(text(result), /Invalid UTF-8.*cannot be used as edit anchors/);
    assert.doesNotMatch(text(result), /\d+#|Search incomplete/);
    assert.deepEqual(await readFile(invalid), source);

    const binary = join(dir, "nul.txt");
    const binarySource = Buffer.from("a\nb\0c");
    await writeFile(binary, binarySource);
    const binaryBackend = fakeBackend({ lines: [rgMatch(binary, 1, "a\n")], paths: [binary] });
    // Single-line files/count filtering belongs to runRgTextView and is covered by real-rg tests.
    for (const { outputMode, multiline } of [
      { outputMode: "content", multiline: false },
      { outputMode: "content", multiline: true },
      { outputMode: "files", multiline: true },
      { outputMode: "count", multiline: true },
    ] as const) {
      const skipped = await call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, binaryBackend.backend),
        { literal: true, pattern: "a", path: binary, outputMode, multiline },
      );
      assert.equal(text(skipped), "No matches found");
    }
    assert.deepEqual(await readFile(binary), binarySource);
  });
});

test("single-line files and count modes do not reread a matched file after it disappears", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "listed.txt");
    for (const outputMode of ["files", "count"] as const) {
      await writeFile(file, "needle\n");
      const fake = fakeBackend({ lines: [rgMatch(file, 1, "needle\n")] });
      const backend: GrepBackend = {
        ...fake.backend,
        async search(...args) {
          // Scope resolution has succeeded; the backend can still deliver a hit already read by rg.
          await rm(file);
          return fake.backend.search(...args);
        },
      };
      const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
        literal: true,
        pattern: "needle",
        path: file,
        outputMode,
      });
      assert.equal(
        text(result),
        outputMode === "files" ? "listed.txt" : "listed.txt: 1\nTotal: 1 match in 1 file",
      );
      assert.equal(result.details, undefined);
      assert.equal(fake.calls.length, 1);
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  });
});

test("partial searches retain matches and surface stderr across output modes", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "found.txt");
    await writeFile(file, "needle\n");
    for (const outputMode of ["content", "files", "count"]) {
      for (const limit of [1, 10]) {
        const fake = fakeBackend({
          lines: [rgMatch(file, 1, "needle\n")],
          code: 2,
          stderr: "unreadable.txt: Permission denied",
        });
        const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
          literal: true,
          pattern: "needle",
          outputMode,
          limit,
        });
        assert.match(text(result), /found\.txt/);
        assert.match(
          text(result),
          /Search incomplete; results and counts cover only confirmed matches/,
        );
        assert.match(text(result), /unreadable\.txt: Permission denied/);
        assert.equal(result.details.incomplete, true);
      }
    }
    const fake = fakeBackend({ code: 2, stderr: "Permission denied" });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
        literal: true,
        pattern: "needle",
      }),
      /No matches confirmed.*Search incomplete/s,
    );
  });
});

test("first-match revision read errors retain results from other files", async () =>
  withDir(async (dir) => {
    const good = join(dir, "good.txt");
    const gone = join(dir, "gone.txt");
    await writeFile(good, "needle\n");
    await writeFile(gone, "needle\n");
    const fake = fakeBackend({
      lines: [rgMatch(good, 1, "needle\n"), rgMatch(gone, 1, "needle\n")],
    });
    const backend: GrepBackend = {
      ...fake.backend,
      async search(...args) {
        await rm(gone);
        return fake.backend.search(...args);
      },
    };
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
      literal: true,
      pattern: "needle",
    });
    assert.match(text(result), /good\.txt · 1 match/);
    assert.doesNotMatch(text(result), /gone\.txt · 1 match/);
    assert.match(text(result), /Search incomplete/);
    assert.match(text(result), /Could not read.*gone\.txt/);
    assert.equal(result.details.incomplete, true);
  }));

test("failed result reads report incomplete coverage while retaining readable files", async () => {
  await withDir(async (dir) => {
    const good = join(dir, "good.txt");
    const gone = join(dir, "gone.txt");
    await writeFile(good, "needle\n");
    await writeFile(gone, "needle\n");
    const fake = fakeBackend({
      lines: [rgMatch(gone, 1, "needle\n"), rgMatch(good, 1, "needle\n")],
    });
    const result = await call(
      makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {
        ...fake.backend,
        search: async (...args) => {
          const result = await fake.backend.search(...args);
          await rm(gone);
          return result;
        },
      }),
      { literal: true, pattern: "needle" },
    );
    assert.match(text(result), /good\.txt · 1 match/);
    assert.doesNotMatch(text(result), /gone\.txt · 1 match/);
    assert.match(text(result), /Search incomplete/);
    assert.match(text(result), /Could not read.*gone\.txt/);
  });
});

test("explicit-file glob listing warnings retain confirmed matches", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.txt");
    await writeFile(file, "needle\n");
    const event = JSON.stringify({
      type: "match",
      data: {
        path: { text: file },
        line_number: 1,
        lines: { text: "needle\n" },
        submatches: [{ start: 0, end: 6 }],
      },
    });
    const fake = fakeBackend({ paths: [file], lines: [event] });
    const listing = await call(
      makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {
        ...fake.backend,
        runRgPaths: async (...args) => {
          const result = await fake.backend.runRgPaths(...args);
          return { ...result, code: 2, stderr: "directory: Permission denied" };
        },
      }),
      { literal: true, pattern: "needle", path: file, glob: "*.txt" },
    );
    assert.match(text(listing), /1#[0-9A-Z]+│needle/);
    assert.match(text(listing), /Search incomplete/);
  });
});

test("concurrent file reads preserve discovery order across multiple matched files", async () => {
  await withDir(async (dir) => {
    const files: string[] = [];
    const matches: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const file = join(dir, `file_${String(i).padStart(2, "0")}.txt`);
      await writeFile(file, `header\nmatch_${i}\nfooter\n`);
      files.push(file);
      matches.push(rgMatch(file, 2, `match_${i}\n`));
    }
    const fake = fakeBackend({ lines: matches, paths: files });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "match",
    });
    const content = text(result);
    // Verify each file block appears in exact discovery order
    let lastIndex = -1;
    for (let i = 1; i <= 25; i++) {
      const pad = String(i).padStart(2, "0");
      const expectedHeader = `file_${pad}.txt · 1 match`;
      const idx = content.indexOf(expectedHeader);
      assert.ok(
        idx > lastIndex,
        `Expected ${expectedHeader} at index > ${lastIndex}, found ${idx}`,
      );
      lastIndex = idx;
      assert.match(content, new RegExp(`2#[0-9A-Z]+│match_${i}`));
    }
  });
});

test("fatal format errors stop workers from starting new file reads after rejection", async () =>
  withDir(async (dir) => {
    const events: string[] = [];
    for (let i = 0; i < 60; i++) {
      const file = join(dir, `file_${i}.txt`);
      await writeFile(file, i === 0 ? "changed\n" : `needle\n${"x".repeat(256 * 1024)}\n`);
      events.push(rgMatch(file, 1, "needle\n"));
    }
    const original = fs.createReadStream;
    let started = 0;
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      if (typeof args[0] === "string" && args[0].startsWith(dir)) started++;
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const fake = fakeBackend({ lines: events });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
          literal: true,
          pattern: "needle",
        }),
        /File changed during search/,
      );
      const atRejection = started;
      assert.ok(atRejection > 60, "expected to observe format-stage streams");
      await delay(350);
      assert.equal(started, atRejection, "file reads started after the tool rejected");
    } finally {
      fs.createReadStream = original;
      syncBuiltinESMExports();
    }
  }));

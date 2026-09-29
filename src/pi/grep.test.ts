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
import { validateToolArguments } from "@earendil-works/pi-ai";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { getState } from "./state.ts";
import { callTool } from "./tool-call.testing.ts";

type FakeOptions = {
  lines?: string[];
  code?: number | null;
  stderr?: string;
  validation?: { code: number | null; stderr: string };
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
  const calls: { path: string; args: string[] }[] = [];
  const backend: GrepBackend = {
    async runRg(path, args, _signal, onLine) {
      calls.push({ path, args });
      options.onRun?.();
      if (options.error) throw options.error;
      if (args.includes("--quiet")) {
        return { code: 1, stderr: "", ...options.validation, stopped: false };
      }
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
  };
  return { backend, calls };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  callTool(tool, params, { toolCallId: "0", signal });

test("grep guidance covers literal, case, and multiline searches", () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), {});
  assert.ok(
    tool.promptGuidelines.some(
      (rule: string) => rule.includes("literal:true") && rule.includes("literal:false"),
    ),
  );
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes("pattern array")));
  assert.ok(
    tool.promptGuidelines.some(
      (rule: string) =>
        rule.includes("grep anchors") && rule.includes("partial") && rule.includes("full"),
    ),
  );
  assert.match(JSON.stringify(tool.parameters.properties.pattern), /use an array for alternatives/);
  assert.match(JSON.stringify(tool.parameters.properties.literal), /entire input literally/);
  const pathDescription = JSON.stringify(tool.parameters.properties.path);
  assert.match(pathDescription, /Omit path.*working directory/);
  assert.match(pathDescription, /empty strings and arrays are invalid/);
  assert.match(pathDescription, /existing file or directory.*wildcards/);
  assert.match(JSON.stringify(tool.parameters.properties.glob), /filename.*wildcard/);
  assert.match(JSON.stringify(tool.parameters.properties.ignoreCase), /Inline regex case flags/);
  assert.match(JSON.stringify(tool.parameters.properties.multiline), /physical lines.*Context/);
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes("multiline:true")));
  assert.ok(
    tool.promptGuidelines.some(
      (rule: string) =>
        rule.includes("Omit path") && rule.includes("empty path") && rule.includes("glob"),
    ),
  );
});

test("grep exposes nine parameters and rejects only the six removed fields", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
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
        await assert.rejects(call(tool, { pattern: "needle", [key]: input }), (error: Error) =>
          error.message.includes(`- ${key}: schema is false`),
        );
      }
    }
    await assert.rejects(
      call(tool, { pattern: "needle", follow: false, noIgnore: null }),
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
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const limitSchema = tool.parameters.properties.limit;
    assert.equal(limitSchema.type, "number");
    assert.equal("minimum" in limitSchema ? limitSchema.minimum : undefined, 1);
    assert.equal("multipleOf" in limitSchema ? limitSchema.multipleOf : undefined, 1);
    const validate = (limit: number) =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "0",
        name: "grep",
        arguments: { pattern: "needle", limit },
      });
    assert.doesNotThrow(() => validate(1));
    for (const limit of [0, -3, 0.5, 2.5]) {
      assert.throws(
        () => validate(limit),
        /Validation failed/,
        `schema must reject limit ${limit}`,
      );
      await assert.rejects(
        call(tool, { pattern: "needle", limit }),
        /Validation failed for tool "grep":\n {2}- limit: /,
      );
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("grep schema rejects empty search inputs and fractional context", async () =>
  withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const invalidArgs: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { pattern: "" },
      { pattern: [] },
      { pattern: ["ok", ""] },
      { pattern: "needle", path: "" },
      { pattern: "needle", path: [] },
      { pattern: "needle", glob: "" },
      { pattern: "needle", glob: [] },
      { pattern: "needle", context: 1.5 },
      { pattern: "needle", limit: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const args of invalidArgs) {
      assert.throws(
        () =>
          validateToolArguments(tool, {
            type: "toolCall",
            id: "invalid",
            name: "grep",
            arguments: args,
          }),
        /Validation failed/,
        JSON.stringify(args),
      );
    }
    await assert.rejects(
      call(tool, { pattern: "needle", context: 1.5 }),
      /Validation failed for tool "grep":\n {2}- context: /,
    );
    assert.equal(fake.calls.length, 0);
  }));

test("case and multiline options select only their matching ripgrep flags", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.ts");
    await writeFile(file, "FOO\nfoo\n");
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    await call(tool, {
      path: file,
      pattern: "FOO",
      ignoreCase: true,
      multiline: true,
      literal: true,
    });
    assert.ok(fake.calls[0].args.includes("--ignore-case"));
    assert.ok(fake.calls[0].args.includes("--multiline"));
    await call(tool, { path: file, pattern: "foo", ignoreCase: false, multiline: false });
    assert.ok(fake.calls.at(-1)?.args.includes("--case-sensitive"));
    assert.ok(fake.calls.at(-1)?.args.includes("--no-multiline"));
  });
});

test("grep points wildcard paths to glob without changing ordinary missing-path errors", async () => {
  await withDir(async (dir) => {
    const tool = makeGrepOverrideWithBackend(dir, fakeBackend().backend);
    await assert.rejects(
      call(tool, { pattern: "value", path: "src/fusion-card*" }),
      /Path not found: .*fusion-card\*.*Use an existing directory as path and a filename wildcard as glob/,
    );
    await assert.rejects(
      call(tool, { pattern: "value", path: "src/missing" }),
      (error: Error) =>
        error.message.endsWith("src\\missing") || error.message.endsWith("src/missing"),
    );
  });
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
        args: [
          "--no-config",
          "--color=never",
          "--no-crlf",
          "--engine=default",
          "--no-multiline",
          "--ignore-case",
          "--fixed-strings",
          "--json",
          "--line-number",
          "--hidden",
          "-e",
          "alpha",
          "--",
          dir,
        ],
      });
    }),
  );
});

test("grep rejects a file changed between a match and anchor formatting", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    await writeFile(file, "needle\nother\n");
    const fake = fakeBackend({ lines: [rgMatch(file, 1, "needle\n")] });
    const backend: GrepBackend = {
      ...fake.backend,
      async runRg(...args) {
        const result = await fake.backend.runRg(...args);
        await writeFile(file, "NOT_THE_MATCH\nneedle\n");
        return result;
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, backend), { pattern: "needle" }),
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
      async runRg(...args) {
        await writeFile(file, "line1\nline2\nline3\n");
        return fake.backend.runRg(...args);
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, backend), { pattern: "needle", context: 2 }),
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
      async runRg(...args) {
        await writeFile(file, "one\ntwo\n");
        return fake.backend.runRg(...args);
      },
    };
    for (const outputMode of ["content", "files", "count"]) {
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, backend), {
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
      call(makeGrepOverrideWithBackend(dir, fake.backend), {
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
      async runRg(...args) {
        const result = await fake.backend.runRg(...args);
        await writeFile(file, "needle\nnew context\n");
        return result;
      },
    };
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, backend), { pattern: "needle", context: 1 }),
      /File changed during search/,
    );
  });
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

test("context preserves logical CRLF anchors around a matched line", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(
        file,
        "outside-before\r\nalpha beta drop\r\nbefore survivor\r\nalpha beta\r\nafter survivor\r\nalpha only\r\noutside-after\r\n",
      );
      const fake = fakeBackend({ lines: [rgMatch(file, 4, "alpha beta\n")] });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      const contextSchema: any = tool.parameters.properties.context;
      assert.equal(contextSchema.type, "number");
      assert.equal(contextSchema.minimum, 0);
      assert.equal(contextSchema.maximum, 20);
      assert.equal(contextSchema.multipleOf, 1);
      const result = await call(tool, { pattern: "beta$", context: 1 });
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
        literal: true,
        outputMode: "files",
      });
      assert.equal(text(files), "a.ts\nb.ts");
      assert.deepEqual(fake.calls[0].args, [
        "--no-config",
        "--color=never",
        "--no-crlf",
        "--engine=default",
        "--no-multiline",
        "--case-sensitive",
        "--fixed-strings",
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
        limit: 1,
      });
      assert.match(text(result), /1#[0-9A-Z]+│alpha beta/);
      assert.match(
        text(result),
        /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/,
      );
    }),
  );
});

test("auto-detects literal or regex mode and keeps explicit overrides", async () => {
  await withDir(async (dir) => {
    const valid = fakeBackend();
    const invalid = fakeBackend({
      validation: { code: 2, stderr: "regex parse error:\nerror: unclosed group" },
    });
    const tool = makeGrepOverrideWithBackend(dir, valid.backend);
    const fallback = makeGrepOverrideWithBackend(dir, invalid.backend);

    const result = await call(fallback, { pattern: "queueTool(" });
    assert.match(text(result), /Invalid regex; searched the pattern as literal text/);
    await assert.rejects(
      call(fallback, { pattern: ["plain", "broken("] }),
      /Invalid regex in compound query; automatic literal fallback is disabled/,
    );
    await call(tool, { pattern: "value.*" });
    await call(tool, { pattern: "plain", literal: false });
    await call(tool, { pattern: "value.*", literal: true });

    assert.deepEqual(
      [...invalid.calls, ...valid.calls]
        .filter(({ args }) => !args.includes("--quiet"))
        .map(({ args }) => args.includes("--fixed-strings")),
      [true, false, false, true],
    );
    assert.equal(valid.calls.filter(({ args }) => args.includes("--quiet")).length, 2);
    assert.deepEqual(invalid.calls[0].args, [
      "--no-config",
      "--color=never",
      "--no-crlf",
      "--engine=default",
      "--no-multiline",
      "--quiet",
      "-e",
      "queueTool(",
      "--",
      "-",
    ]);

    const failed = fakeBackend({ validation: { code: 2, stderr: "Permission denied" } });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, failed.backend), { pattern: "value.*" }),
      /Permission denied/,
    );
    assert.equal(failed.calls.length, 1);
  });
});

test("uses smart-case across the entire OR pattern array", async () => {
  await withDir(async (dir) => {
    const target = join(dir, "case.ts");
    await writeFile(target, "FOO alpha\n");

    const lower = fakeBackend({ lines: [rgMatch(target, 1, "FOO alpha\n")] });
    const lowerResult = await call(makeGrepOverrideWithBackend(dir, lower.backend), {
      pattern: ["foo", "alpha"],
    });
    assert.match(text(lowerResult), /FOO alpha/);

    const mixed = fakeBackend();
    const mixedResult = await call(makeGrepOverrideWithBackend(dir, mixed.backend), {
      pattern: ["Foo", "alpha"],
    });
    assert.equal(text(mixedResult), "No matches found");

    const flags = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, flags.backend);
    await call(tool, { pattern: "lower" });
    await call(tool, { pattern: "Upper" });
    await call(tool, { pattern: "foo\\S*" });
    assert.deepEqual(
      flags.calls
        .filter(({ args }) => !args.includes("--quiet"))
        .map(({ args }) => [args.includes("--ignore-case"), args.includes("--case-sensitive")]),
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
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const patterns = Array.from({ length: 17 }, (_, index) => `pattern${index}`);
    assert.equal(text(await call(tool, { pattern: patterns })), "No matches found");
    assert.deepEqual(
      fake.calls[0].args.flatMap((arg, index, args) => (args[index - 1] === "-e" ? [arg] : [])),
      patterns,
    );
  });
});

test("rejects empty patterns while allowing wildcard, literal, and empty-line searches", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);

    for (const pattern of ["", [], ["valid", ""]]) {
      await assert.rejects(call(tool, { pattern }), /Validation failed for tool "grep"/);
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

test("grep accepts nonempty whitespace literals", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    for (const pattern of ["  ", "\t", ["word", " "]]) {
      assert.equal(text(await call(tool, { pattern, literal: true })), "No matches found");
    }
    assert.equal(fake.calls.length, 3);
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
        { pattern: ["x", "y"] },
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
    const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
      pattern: ["foo", "bar"],
      literal: true,
      outputMode: "count",
      limit: 5000,
    });
    assert.match(text(result), /fixture\.ts: 4097/);
    assert.deepEqual(
      fake.calls[0].args.flatMap((arg, index, args) => (args[index - 1] === "-e" ? [arg] : [])),
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
    const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
      pattern: "foo",
      literal: true,
      outputMode: "count",
    });
    assert.match(text(result), /large\.ts: 3/);
    assert.equal(fake.calls.length, 1);
  });
});

test("grep rejects malformed UTF-8 and NUL bytes instead of hashing binary text", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const cases = [
        {
          name: "invalid.txt",
          bytes: Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]),
          error: /UNSUPPORTED_ENCODING/,
        },
        { name: "nul.txt", bytes: Buffer.from([0x61, 0x00, 0x62]), error: /UNSUPPORTED_TEXT/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, fixture.name);
        await writeFile(file, fixture.bytes);
        const fake = fakeBackend({ lines: [rgMatch(file, 1, "a\n")], paths: [file] });
        await assert.rejects(
          call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "a", path: file }),
          fixture.error,
        );
        assert.deepEqual(await readFile(file), fixture.bytes);
      }
    }),
  );
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
        const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
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
      call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "needle" }),
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
      async runRg(...args) {
        await rm(gone);
        return fake.backend.runRg(...args);
      },
    };
    const result = await call(makeGrepOverrideWithBackend(dir, backend), { pattern: "needle" });
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
      makeGrepOverrideWithBackend(dir, {
        ...fake.backend,
        runRg: async (...args) => {
          const result = await fake.backend.runRg(...args);
          await rm(gone);
          return result;
        },
      }),
      { pattern: "needle" },
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
      makeGrepOverrideWithBackend(dir, {
        ...fake.backend,
        runRgPaths: async (...args) => {
          const result = await fake.backend.runRgPaths(...args);
          return { ...result, code: 2, stderr: "directory: Permission denied" };
        },
      }),
      { pattern: "needle", path: file, glob: "*.txt" },
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
    const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "match" });
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
        call(makeGrepOverrideWithBackend(dir, fake.backend), { pattern: "needle" }),
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

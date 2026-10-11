import { argumentError, rejectsArgument, rejectsArguments } from "./argument-error.testing.ts";
/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { Worker } from "node:worker_threads";
import { makeEditOverride } from "./edit-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { FORGET_MIN_BYTES } from "./budgets.ts";
import { taggedResultId } from "./forget.testing.ts";
import { reportOf } from "./report.ts";
import { expectToolFailure } from "./report-failure.testing.ts";

type FakeOptions = {
  code?: number | null;
  stderr?: string;
  error?: Error;
  onRun?: () => void | Promise<void>;
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

function fakeBackend(options: FakeOptions = {}) {
  const calls: { path: string; args: readonly string[] }[] = [];
  const backend: GrepBackend = {
    async runRgPaths(path, args, _signal, onPath) {
      calls.push({ path, args });
      await options.onRun?.();
      if (options.error) throw options.error;
      for (const file of options.paths ?? []) {
        if (!(await onPath(file)))
          return { code: null, stderr: options.stderr ?? "", stopped: true };
      }
      return {
        code: options.code ?? (options.paths?.length ? 0 : 1),
        stderr: options.stderr ?? "",
        stopped: false,
      };
    },
  };
  return { backend, calls };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  callTool(tool, params, { toolCallId: "0", signal });

test("explicit JavaScript flags → call rendering shows them", () => {
  initTheme("dark");
  const { backend } = fakeBackend();
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, backend);
  const rendered = tool.renderCall!({ pattern: "\\p{Letter}+", literal: false, flags: "u" }, theme)
    .render(120)
    .join("\n");
  assert.ok(rendered.includes("/\\p{Letter}+/u"));
});

test("configured defaults → descriptions, limits, and context use the registered values", async () =>
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
    const fake = fakeBackend({ paths: [file] });
    const config = {
      ...DEFAULT_CONFIG,
      grep: { ...DEFAULT_CONFIG.grep, defaultLimit: 1, defaultContext: 2 },
    };
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
    assert.equal(reportOf(defaults)?.matchLimit, config.grep.defaultLimit);

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

test("grep exposes its declared parameters and rejects removed fields", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
      "context",
      "flags",
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
          rejectsArgument(key, /not allowed/),
        );
      }
    }
    await assert.rejects(
      call(tool, { literal: true, pattern: "needle", follow: false, noIgnore: null }),
      (error: Error) =>
        rejectsArgument("follow", /not allowed/)(error) &&
        rejectsArgument("noIgnore", /not allowed/)(error),
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
        rejectsArgument("limit"),
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
      await assert.rejects(call(tool, args), rejectsArguments("grep"), JSON.stringify(args));
    }
    await assert.rejects(
      call(tool, { literal: true, pattern: "needle", context: 1.5 }),
      rejectsArgument("context"),
    );
    assert.equal(fake.calls.length, 0);
  }));

test("grep points wildcard paths to glob without changing ordinary missing-path errors", async () => {
  await withDir(async (dir) => {
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fakeBackend().backend);
    await expectToolFailure(
      call(tool, { literal: true, pattern: "value", path: "src/fusion-card*" }),
      "PATH_NOT_FOUND",
      (report) => {
        assert.equal(report.path, "src/fusion-card*");
        assert.match(report.next ?? "", /directory.*path.*wildcard.*glob/);
      },
    );
    await expectToolFailure(
      call(tool, { literal: true, pattern: "value", path: "src/missing" }),
      "PATH_NOT_FOUND",
      (report) => {
        assert.equal(report.path, "src/missing");
        assert.equal(report.next, "Check the path.");
      },
    );
  });
});

test("matched files → full-line hash anchors", async () => {
  await withDir(async (dir) => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await writeFile(a, "alpha beta\ngamma\nalpha only\n");
    await writeFile(b, "alpha here\n");
    const fake = fakeBackend({ paths: [a, b] });

    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    assert.deepEqual(tool.parameters.required, ["pattern", "literal"]);
    const result = await call(tool, { literal: true, pattern: "alpha" });
    const output = text(result);
    assert.match(output, /a\.ts · 2 matches/);
    assert.match(output, /b\.ts · 1 match/);
    assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta", 4)}│alpha beta`));
    assert.match(output, /3#[0-9A-Z]+│alpha only/);
    assert.equal(fake.calls[0].path, rgPath);
  });
});

test("file changes after matching → every output mode rejects its stale revision", async (t) => {
  await withDir(async (dir) => {
    const file = join(dir, "grep.txt");
    for (const [before, after] of [
      [Buffer.from("needle\nold context\n"), Buffer.from("needle\nnew context\n")],
      [
        Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a, 0xff]),
        Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a, 0xfe]),
      ],
    ]) {
      for (const multiline of [false, true]) {
        for (const outputMode of ["content", "files", "count"] as const) {
          await t.test(
            `${outputMode}, multiline=${multiline}, bytes=${before.toString("hex")} → FILE_CHANGED`,
            async (t) => {
              await writeFile(file, before);
              const emit = Worker.prototype.emit;
              let changed = false;
              t.mock.method(
                Worker.prototype,
                "emit",
                function (this: Worker, event: string | symbol, ...args: unknown[]) {
                  if (event === "message" && !changed) {
                    changed = true;
                    fs.writeFileSync(file, after);
                  }
                  return emit.call(this, event, ...args);
                },
              );
              const fake = fakeBackend({ paths: [file] });
              await expectToolFailure(
                call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
                  pattern: "needle",
                  literal: true,
                  multiline,
                  outputMode,
                  context: 1,
                  limit: 1,
                }),
                "FILE_CHANGED",
              );
              assert.equal(changed, true);
            },
          );
        }
      }
    }
  });
});

test("grep in a subdirectory returns a path that edits the matching file", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "src"));
    const original = "export const status = 1;\nexport const context = 1;\n";
    const rootFile = join(dir, "status.ts");
    const matchedFile = join(dir, "src", "status.ts");
    await writeFile(rootFile, original);
    await writeFile(matchedFile, original);
    const fake = fakeBackend({ paths: [matchedFile] });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "status",
      path: "src",
      context: 1,
    });
    const output = text(result);
    const displayPath = output.split(" · ")[0];
    const contextAnchor = /^(2#[0-9A-Z]+)│/m.exec(output)?.[1];
    assert.ok(contextAnchor);
    const edit: any = makeEditOverride(dir, DEFAULT_CONFIG);
    await call(edit, {
      path: displayPath,
      edits: [
        {
          op: "replace",
          anchor: contextAnchor,
          body: ["export const context = 2;"],
        },
      ],
    });
    assert.equal(
      await readFile(matchedFile, "utf-8"),
      "export const status = 1;\nexport const context = 2;\n",
    );
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
    const fake = fakeBackend({ paths: [file] });

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

test("scope filters and output modes → confirmed files and counts are preserved", async () => {
  await withDir(async (dir) => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await writeFile(a, "Foo a.b\n");
    await writeFile(b, "foo a.b\n");
    const fake = fakeBackend({ paths: [a, b] });

    const files = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: ["Foo", "a.b"],
      path: ["a.ts", "b.ts"],
      glob: ["*.ts", "!**/*.test.ts"],
      literal: true,
      outputMode: "files",
    });
    assert.deepEqual(text(files).split("\n").sort(), ["a.ts", "b.ts"]);
    assert.ok(
      fake.calls.some(({ args }) => args.includes("*.ts") && args.includes("!**/*.test.ts")),
    );
    assert.deepEqual(fake.calls.at(-1)?.args.slice(-2), [a, b]);

    const count = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "foo",
      outputMode: "count",
    });
    assert.deepEqual(text(count).split("\n").sort(), ["a.ts: 1", "b.ts: 1"]);
    assert.equal(reportOf(count)?.matches, 2);
    assert.equal(reportOf(count)?.files, 2);
  });
});

for (const diagnosticLineCount of [0, 80]) {
  test(`grep renders ${diagnosticLineCount ? "long errors fully when expanded" : "short errors fully when collapsed"}`, async () => {
    initTheme("dark");
    const diagnostic = [
      "rg: initialization failed:",
      "    loading search engine",
      ...Array.from({ length: diagnosticLineCount }, (_, index) => `diagnostic ${index}`),
      "error: missing runtime library",
    ].join("\n");
    const fake = fakeBackend({ code: 2, stderr: diagnostic });
    const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, fake.backend);
    const args = { pattern: "(?<=a+)b", literal: false };
    const failure: Awaited<ReturnType<typeof tool.execute>> = await callTool(tool, args);
    assert.equal(failure.isError, true);
    const errorText = failure.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const render = (expanded: boolean) =>
      tool
        .renderResult(
          { content: [{ type: "text", text: errorText }], details: undefined },
          { isPartial: false, expanded },
          theme,
          {
            args,
            toolCallId: "test",
            invalidate() {},
            lastComponent: undefined,
            state: {},
            cwd: process.cwd(),
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded,
            showImages: false,
            isError: true,
          },
        )
        .render(120)
        .join("\n");

    const collapsed = render(false);
    const expanded = render(true);
    for (const line of diagnostic.split("\n")) {
      assert.ok(expanded.includes(line), `Expanded error omitted ${JSON.stringify(line)}`);
      if (!diagnosticLineCount) {
        assert.ok(collapsed.includes(line), `Collapsed error omitted ${JSON.stringify(line)}`);
      }
    }
    if (diagnosticLineCount) {
      assert.match(collapsed, /initialization failed/);
      assert.doesNotMatch(collapsed, /missing runtime library/);
      assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
    }
  });
}

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

test("matching rows exceed limit → bounded results carry matchLimit", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.ts");
    await writeFile(file, "alpha beta\nalpha only\nalpha later\n");
    const fake = fakeBackend({ paths: [file] });

    const limit = 1;
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "alpha",
      limit,
    });
    assert.match(text(result), /1#[0-9A-Z]+│alpha beta/);
    assert.equal(reportOf(result)?.matchLimit, limit);
    assert.match(reportOf(result)?.next ?? "", /limit.*refine.*pattern/);
  });
});

test("grep requires literal before invoking the backend", async () => {
  const fake = fakeBackend();
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, fake.backend);
  await assert.rejects(callTool(tool, { pattern: "needle" }), rejectsArgument("literal"));
  assert.equal(fake.calls.length, 0);
});

test("literal punctuation → exact text is matched", async () =>
  withDir(async (dir) => {
    const file = join(dir, "literal.txt");
    await writeFile(file, "foo(0)\n");
    const fake = fakeBackend({ paths: [file] });
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const result = await call(tool, { pattern: "foo(0)", literal: true });
    assert.match(text(result), /1#[0-9A-Z]+│foo\(0\)/);
    assert.equal(fake.calls.length, 1);
  }));

test("invalid JavaScript → its field rejects before file discovery", async () =>
  withDir(async (dir) => {
    for (const value of ["(", "(?m)^foo", "(?i)abc"]) {
      for (const pattern of [value, ["plain", value]]) {
        const fake = fakeBackend();
        const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
        const field = typeof pattern === "string" ? "pattern" : "pattern[1]";
        await assert.rejects(
          call(tool, { pattern, literal: false }),
          rejectsArgument(field, /Invalid regular expression/),
        );
        assert.equal(fake.calls.length, 0);
      }
    }
  }));

test("grep OR arrays accept more than sixteen patterns in one line scan", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    const patterns = Array.from({ length: 17 }, (_, index) => `pattern${index}`);
    assert.equal(reportOf(await call(tool, { literal: true, pattern: patterns }))?.matches, 0);
    assert.equal(fake.calls.length, 1);
  });
});

test("rejects empty patterns while allowing character classes, literals, and empty-line searches", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);

    for (const pattern of ["", [], ["valid", ""]]) {
      await assert.rejects(call(tool, { pattern, literal: true }), rejectsArguments("grep"));
    }
    assert.equal(fake.calls.length, 0);
    for (const pattern of ["[\\w.*]*", "^[\\w.*]+$", "[\\w.*]?"]) {
      assert.equal(reportOf(await call(tool, { pattern, literal: false }))?.matches, 0);
    }

    assert.equal(reportOf(await call(tool, { pattern: ".*", literal: true }))?.matches, 0);
    assert.equal(reportOf(await call(tool, { pattern: "^$", literal: false }))?.matches, 0);
    assert.equal(fake.calls.length, 5);
  });
});

test("grep accepts nonempty whitespace literals", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
    for (const pattern of ["  ", "\t", ["word", " "]]) {
      assert.equal(reportOf(await call(tool, { pattern, literal: true }))?.matches, 0);
    }
    assert.equal(fake.calls.length, 3);
  });
});

test("reports empty output and ripgrep execution failures", async () => {
  await withDir(async (dir) => {
    const empty = fakeBackend({ code: 1 });
    const noMatches = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, empty.backend), {
      literal: true,
      pattern: "missing",
    });
    assert.equal(noMatches.isError, undefined);
    assert.equal(reportOf(noMatches)?.matches, 0);
    assert.equal(reportOf(noMatches)?.files, 0);

    const failed = fakeBackend({ code: 2, stderr: "bad regex" });
    await expectToolFailure(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, failed.backend), {
        pattern: "x",
        literal: false,
      }),
      "SEARCH_INCOMPLETE",
      (report) => {
        assert.match(report.diagnostics ?? "", /bad regex/);
      },
    );

    const rejected = fakeBackend({ error: new Error("spawn failed") });
    await expectToolFailure(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, rejected.backend), {
        literal: true,
        pattern: "x",
      }),
      "UNCLASSIFIED",
      (report) => {
        assert.match(report.message ?? "", /spawn failed/);
      },
    );
  });
});

test("rejects calls aborted before or during rg execution", async () => {
  await withDir(async (dir) => {
    const alreadyAborted = fakeBackend();
    const first = new AbortController();
    first.abort();
    await expectToolFailure(
      call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, alreadyAborted.backend),
        { literal: true, pattern: ["x", "y"] },
        first.signal,
      ),
      "OPERATION_ABORTED",
    );

    const controller = new AbortController();
    const interrupted = fakeBackend({ onRun: () => controller.abort() });
    await expectToolFailure(
      call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, interrupted.backend),
        { literal: true, pattern: ["x", "y"] },
        controller.signal,
      ),
      "OPERATION_ABORTED",
    );
  });
});

test("overlapping OR patterns → each matched line counts once", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.ts");
    await writeFile(file, "foo bar\n".repeat(4097));
    const fake = fakeBackend({ paths: [file] });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: ["foo", "bar"],
      literal: true,
      outputMode: "count",
      limit: 5000,
    });
    assert.match(text(result), /fixture\.ts: 4097/);
    assert.equal(fake.calls.length, 1);
  });
});

test("long matching lines → counts do not depend on content previews", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "large.ts");
    const line = `foo${"x".repeat(600_000)}\n`;
    await writeFile(file, line.repeat(3));
    const fake = fakeBackend({ paths: [file] });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      pattern: "foo",
      literal: true,
      outputMode: "count",
    });
    assert.match(text(result), /large\.ts: 3/);
    assert.equal(fake.calls.length, 1);
  });
});

test("grep previews invalid UTF-8 without anchors and skips NUL hits in every mode", async () => {
  await withDir(async (dir) => {
    const invalid = join(dir, "invalid.txt");
    const source = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]);
    await writeFile(invalid, source);
    const fake = fakeBackend({
      paths: [invalid],
    });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "a",
      path: invalid,
      context: 1,
    });
    assert.match(text(result), /1│a\n2│�\(/);
    assert.deepEqual(reportOf(result)?.invalidUtf8, ["invalid.txt"]);
    assert.doesNotMatch(text(result), /\d+#/);
    assert.equal(reportOf(result)?.diagnostics, undefined);
    assert.deepEqual(await readFile(invalid), source);

    const binary = join(dir, "nul.txt");
    const binarySource = Buffer.from("a\nb\0c");
    await writeFile(binary, binarySource);
    const binaryBackend = fakeBackend({ paths: [binary] });
    for (const { outputMode, multiline } of [
      { outputMode: "content", multiline: false },
      { outputMode: "content", multiline: true },
      { outputMode: "files", multiline: false },
      { outputMode: "count", multiline: false },
      { outputMode: "files", multiline: true },
      { outputMode: "count", multiline: true },
    ] as const) {
      const skipped = await call(
        makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, binaryBackend.backend),
        { literal: true, pattern: "a", path: binary, outputMode, multiline },
      );
      assert.equal(reportOf(skipped)?.matches, 0);
      assert.equal(skipped.isError, undefined);
    }
    assert.deepEqual(await readFile(binary), binarySource);
  });
});

test("candidate file disappears before reading → summary modes report incomplete coverage", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "listed.txt");
    for (const outputMode of ["files", "count"] as const) {
      await writeFile(file, "needle\n");
      const fake = fakeBackend({ paths: [file], onRun: () => rm(file) });
      const backend = fake.backend;
      await expectToolFailure(
        call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
          literal: true,
          pattern: "needle",
          path: file,
          outputMode,
        }),
        "SEARCH_INCOMPLETE",
        (report) => {
          assert.match(report.diagnostics ?? "", /Could not read .*listed\.txt: ENOENT/);
        },
      );
      assert.equal(fake.calls.length, 1);
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  });
});

test("candidate listing reports errors → all output modes retain confirmed matches and diagnostics", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "found.txt");
    const rowPayloadChars = 256;
    const rows = Array.from(
      { length: Math.ceil(FORGET_MIN_BYTES / rowPayloadChars) + 1 },
      () => `needle ${"x".repeat(rowPayloadChars)}\n`,
    );
    await writeFile(file, rows.join(""));
    for (const outputMode of ["content", "files", "count"]) {
      for (const limit of [1, 10]) {
        const fake = fakeBackend({
          paths: [file],
          code: 2,
          stderr: "unreadable.txt: Permission denied",
        });
        const result = await call(
          makeGrepOverrideWithBackend(dir, { ...DEFAULT_CONFIG, forget: true }, fake.backend),
          {
            literal: true,
            pattern: "needle",
            outputMode,
            limit,
          },
        );
        assert.match(text(result), /found\.txt/);
        assert.ok(reportOf(result)?.diagnostics);
        assert.match(
          JSON.stringify(reportOf(result)?.diagnostics),
          /unreadable\.txt: Permission denied/,
        );
        assert.equal(
          result.details.forgetReceipt,
          outputMode === "content" && limit >= rows.length
            ? `grep /needle/ · ${rows.length} matches in 1 file · incomplete`
            : undefined,
        );
      }
    }
    const fake = fakeBackend({ code: 2, stderr: "Permission denied" });
    await expectToolFailure(
      call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
        literal: true,
        pattern: "needle",
      }),
      "SEARCH_INCOMPLETE",
      (report) => {
        assert.match(JSON.stringify(report.diagnostics), /Permission denied/);
      },
    );
  });
});

test("one candidate cannot be read → matches from other files remain available", async () =>
  withDir(async (dir) => {
    const good = join(dir, "good.txt");
    const gone = join(dir, "gone.txt");
    await writeFile(good, "needle\n");
    await writeFile(gone, "needle\n");
    const fake = fakeBackend({ paths: [good, gone], onRun: () => rm(gone) });
    const backend = fake.backend;
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
      literal: true,
      pattern: "needle",
    });
    assert.match(text(result), /good\.txt · 1 match/);
    assert.doesNotMatch(text(result), /gone\.txt · 1 match/);
    assert.match(JSON.stringify(reportOf(result)?.diagnostics), /gone\.txt/);
  }));

test("explicit-file glob listing reports warnings → confirmed matches remain available", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "fixture.txt");
    await writeFile(file, "needle\n");
    const fake = fakeBackend({ paths: [file] });
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
    assert.match(reportOf(listing)?.diagnostics ?? "", /directory: Permission denied/);
  });
});

test("concurrent file searches → all discovered matches remain present", async () => {
  await withDir(async (dir) => {
    const files: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const file = join(dir, `file_${String(i).padStart(2, "0")}.txt`);
      await writeFile(file, `header\nmatch_${i}\nfooter\n`);
      files.push(file);
    }
    const fake = fakeBackend({ paths: files });
    const result = await call(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend), {
      literal: true,
      pattern: "match",
    });
    const content = text(result);
    for (let i = 1; i <= 25; i++) {
      const pad = String(i).padStart(2, "0");
      const expectedHeader = `file_${pad}.txt · 1 match`;
      const idx = content.indexOf(expectedHeader);
      assert.ok(idx >= 0, `Missing ${expectedHeader}`);
      assert.match(content, new RegExp(`2#[0-9A-Z]+│match_${i}`));
    }
  });
});

test("grep output exceeds the forget threshold → only content mode receives a tag", async () =>
  withDir(async (dir) => {
    const namePaddingChars = 96;
    const fileCount = Math.ceil(FORGET_MIN_BYTES / namePaddingChars) + 1;
    const paths = Array.from({ length: fileCount }, (_, index) =>
      join(dir, `${index}-${"x".repeat(namePaddingChars)}.txt`),
    );
    await Promise.all(paths.map((path) => writeFile(path, "needle\n")));
    const fake = fakeBackend({ paths });
    const tool = makeGrepOverrideWithBackend(
      dir,
      { ...DEFAULT_CONFIG, forget: true },
      fake.backend,
    );
    for (const outputMode of ["content", "files", "count"] as const) {
      const result: Awaited<ReturnType<typeof tool.execute>> = await callTool(tool, {
        path: dir,
        pattern: "needle",
        literal: true,
        outputMode,
      });
      const body = result.content[0];
      assert.ok(body.type === "text");
      assert.ok(Buffer.byteLength(body.text) >= FORGET_MIN_BYTES);
      assert.equal(taggedResultId(result) !== undefined, outputMode === "content");
    }
  }));

test("scope inspection fails for access or traversal reasons → grep preserves the filesystem failure", async () =>
  withDir(async (dir) => {
    const path = join(dir, "source.txt");
    await writeFile(path, "needle中文\n");
    for (const code of ["EACCES", "ELOOP", "ENOTDIR"]) {
      const failure = Object.assign(new Error(`${code}: cannot inspect ${path}`), { code });
      const original = fsPromises.stat;
      fsPromises.stat = async () => {
        throw failure;
      };
      syncBuiltinESMExports();
      try {
        const fake = fakeBackend();
        const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, fake.backend);
        await expectToolFailure(
          callTool(tool, { path, pattern: "needle", literal: true }),
          "FILESYSTEM_ERROR",
          (report) => {
            assert.equal(report.message, failure.message);
            assert.equal(report.cause, undefined);
            assert.doesNotMatch(report.message ?? "", /Path not found/);
          },
        );
        assert.equal(fake.calls.length, 0);
      } finally {
        fsPromises.stat = original;
        syncBuiltinESMExports();
      }
    }
  }));

test("invalid worker replies → the entire grep call fails", async (t) => {
  await withDir(async (dir) => {
    const path = join(dir, "input.txt");
    await writeFile(path, "😀\n");
    for (const result of [
      { lines: [{ lineNumber: 2, column: 0 }], totalLines: 1 },
      {
        lines: [
          { lineNumber: 1, column: 0 },
          { lineNumber: 1, column: 0 },
        ],
        totalLines: 1,
      },
      { lines: [{ lineNumber: 1, column: 0 }], totalLines: 2 },
      { lines: [{ lineNumber: 1, column: -1 }], totalLines: 1 },
      { lines: [{ lineNumber: 1, column: 999 }], totalLines: 1 },
    ]) {
      await t.test(`${JSON.stringify(result)} → REGEX_WORKER_FAILED`, async (t) => {
        const emit = Worker.prototype.emit;
        t.mock.method(
          Worker.prototype,
          "emit",
          function (this: Worker, event: string | symbol, ...args: unknown[]) {
            return emit.call(this, event, ...(event === "message" ? [{ result }] : args));
          },
        );
        const tool = makeGrepOverrideWithBackend(
          dir,
          DEFAULT_CONFIG,
          fakeBackend({ paths: [path] }).backend,
        );
        await expectToolFailure(
          callTool(tool, { pattern: "^..$", literal: false, path }),
          "REGEX_WORKER_FAILED",
        );
      });
    }
  });
});

test("catastrophic worker evaluation → timeout and cancellation fail the search and release workers", {
  timeout: 15_000,
}, async () => {
  await withDir(async (dir) => {
    const path = join(dir, "input.txt");
    await writeFile(path, `${"a".repeat(100)}!`);
    const config = { ...DEFAULT_CONFIG, grep: { ...DEFAULT_CONFIG.grep, regexTimeoutMs: 3_000 } };
    const tool = makeGrepOverrideWithBackend(dir, config, fakeBackend({ paths: [path] }).backend);
    const params = { path, pattern: "(?=.)^(a+)+$", literal: false };
    await expectToolFailure(callTool(tool, params), "REGEX_TIMEOUT", (report) =>
      assert.equal(report.timeoutMs, config.grep.regexTimeoutMs),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      await expectToolFailure(
        callTool(tool, params, { signal: controller.signal }),
        "OPERATION_ABORTED",
      );
    } finally {
      clearTimeout(timer);
    }
    const recovered = await callTool(tool, { ...params, pattern: "a." });
    assert.equal(recovered.isError, undefined);
    assert.equal(reportOf(recovered)?.matches, 1);
  });
});

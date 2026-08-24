/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { getState } from "./state.ts";

type FakeOptions = {
  lines?: string[];
  code?: number | null;
  stderr?: string;
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

      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "alpha",
      });
      const output = text(result);
      assert.match(output, /a\.ts · 2 matches/);
      assert.match(output, /b\.ts · 1 match/);
      assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta")}│alpha beta`));
      assert.match(output, /3#[0-9A-Z]+│alpha only/);
      assert.deepEqual(fake.calls[0], {
        path: "/fake/rg",
        args: ["--json", "--line-number", "--color=never", "--hidden", "-e", "alpha", "--", dir],
      });
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

      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: ["alpha", "beta$"],
        matchMode: "all",
        excludePattern: "drop",
        context: 1,
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
        glob: "*.ts",
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
        call(makeGrepOverrideWithBackend(dir, failed.backend), { pattern: "[" }),
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
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, absent.backend), {
          pattern: ["x", "y"],
          matchMode: "all",
        }),
        /ripgrep \(rg\) not found/,
      );
    });

    const file = join(dir, "a.ts");
    await writeFile(file, "x y\n");
    const disabled = fakeBackend({ lines: [rgMatch(file, 1, "x y\n")] });
    await withEnabled(false, async () => {
      assert.equal(
        text(await call(makeGrepOverrideWithBackend(dir, disabled.backend), { pattern: "x" })),
        "delegated",
      );
      assert.equal(disabled.calls.length, 0);
      const extended = await call(makeGrepOverrideWithBackend(dir, disabled.backend), {
        pattern: ["x", "y"],
        matchMode: "all",
      });
      assert.match(text(extended), /a\.ts:1: x y/);
      assert.doesNotMatch(text(extended), /#[0-9A-Z]+│/);
      assert.equal(disabled.calls.length, 1);
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

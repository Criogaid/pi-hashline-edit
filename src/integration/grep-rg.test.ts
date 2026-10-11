import { rejectsArgument } from "../pi/argument-error.testing.ts";
/**
 * Explicit integration coverage for the platform rg bundled by @vscode/ripgrep.
 * This suite is excluded from the default test script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rgPath } from "@vscode/ripgrep";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { makeReadOverride } from "../pi/read-tool.ts";
import { makeWriteOverride } from "../pi/write-tool.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { COMMON_RG_ARGS, MAX_RG_RECORD_BYTES, probeRegex, runRg } from "../pi/rg-process.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "../pi/budgets.ts";
import { runRgSearch } from "../pi/grep-search.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { canonicalPath } from "../pi/path.ts";
import { reportOf } from "../pi/report.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

const invoke = (
  tool: any,
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => callTool(tool, args, { toolCallId, signal, onUpdate, ctx });

test("real rg emits anchored matches from a temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-integration-"));
  try {
    const file = join(directory, "fixture.ts");
    await writeFile(file, "needle\nother\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});

    for (const pattern of ["needle", ["needle"]]) {
      const result: any = await invoke(tool, "0", { pattern, literal: true }, undefined, undefined);
      assert.match(result.content[0].text, /fixture\.ts · 1 match/);
      assert.match(result.content[0].text, /1#[0-9A-Z]+│needle/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg finds whitespace-only literal queries and OR alternatives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-whitespace-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "plain word\nfirst\tsecond\nboth \tforms\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const { pattern, expected } of [
      { pattern: " ", expected: 2 },
      { pattern: "\t", expected: 2 },
      { pattern: [" ", "\t"], expected: 3 },
    ]) {
      const result = await invoke(
        tool,
        "0",
        { pattern, path: file, literal: true, outputMode: "count" },
        undefined,
        undefined,
      );
      assert.equal(reportOf(result)?.matches, expected);
      assert.equal(reportOf(result)?.files, 1);
    }
    const lineBreaks = await invoke(
      tool,
      "0",
      { pattern: "\n", path: file, literal: true, multiline: true, outputMode: "count" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(lineBreaks)?.matches, 3);
    assert.equal(reportOf(lineBreaks)?.files, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg uses smart-case across OR patterns and Unicode matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-case-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO abc\nfoo BAR\nfoo bar\nK zip\nk zip\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const lower = await invoke(
      tool,
      "0",
      { literal: true, pattern: ["foo", "bar"] },
      undefined,
      undefined,
    );
    assert.match(lower.content[0].text, /fixture\.ts · 3 matches/);
    assert.match(lower.content[0].text, /│FOO abc/);
    const mixed = await invoke(
      tool,
      "0",
      { literal: true, pattern: ["foo", "BAR"] },
      undefined,
      undefined,
    );
    assert.match(mixed.content[0].text, /fixture\.ts · 2 matches/);
    assert.doesNotMatch(mixed.content[0].text, /│FOO abc/);
    const unicode = await invoke(tool, "0", { literal: true, pattern: "k" }, undefined, undefined);
    assert.match(unicode.content[0].text, /fixture\.ts · 1 match/);
    assert.match(unicode.content[0].text, /│k zip/);
    assert.doesNotMatch(unicode.content[0].text, /│K zip/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit ignoreCase overrides smart-case for regex and literal queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-case-override-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "FOO\nfoo\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const sensitive = await invoke(
      tool,
      "0",
      { literal: true, pattern: "foo", path: file, ignoreCase: false },
      undefined,
      undefined,
    );
    assert.match(sensitive.content[0].text, /fixture\.txt · 1 match/);
    assert.match(sensitive.content[0].text, /2#[0-9A-Z]+│foo/);
    const insensitive = await invoke(
      tool,
      "0",
      { pattern: "FOO", path: file, ignoreCase: true, literal: true },
      undefined,
      undefined,
    );
    assert.match(insensitive.content[0].text, /fixture\.txt · 2 matches/);
    const regex = await invoke(
      tool,
      "0",
      { pattern: "^FOO$", path: file, ignoreCase: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(regex.content[0].text, /fixture\.txt · 2 matches/);
    const inlineSensitive = await invoke(
      tool,
      "0",
      { pattern: "(?-i:^FOO$)", path: file, ignoreCase: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(inlineSensitive.content[0].text, /fixture\.txt · 1 match/);
    const inlineInsensitive = await invoke(
      tool,
      "0",
      { pattern: "(?i:^FOO$)", path: file, ignoreCase: false, literal: false },
      undefined,
      undefined,
    );
    assert.match(inlineInsensitive.content[0].text, /fixture\.txt · 2 matches/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned rg processes ignore RIPGREP_CONFIG_PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-config-"));
  const previous = process.env.RIPGREP_CONFIG_PATH;
  try {
    const config = join(directory, "ripgreprc");
    await writeFile(
      config,
      "--ignore-case\n--fixed-strings\n--invert-match\n--pcre2\n--multiline\n",
    );
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nbar\n");
    process.env.RIPGREP_CONFIG_PATH = config;
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result: any = await invoke(
      tool,
      "0",
      { literal: false, pattern: ["^foo$", "foo"] },
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /fixture\.ts · 2 matches/);
    assert.match(result.content[0].text, /│foo/);
    assert.match(result.content[0].text, /│FOO/);
    assert.doesNotMatch(result.content[0].text, /│bar/);
    await assert.rejects(
      invoke(tool, "0", { pattern: "foo\\nbar", literal: false }),
      rejectsArgument("pattern", /each line.*line break/),
    );
    const multiline = await invoke(
      tool,
      "0",
      { pattern: "foo\\nbar", literal: false, multiline: true },
      undefined,
      undefined,
    );
    assert.match(multiline.content[0].text, /fixture\.ts · 2 matches/);
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg requires an explicit mode and separates exact text from regex", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-regex-"));
  try {
    await writeFile(
      join(directory, "fixture.ts"),
      "FOO\nfoo\nfoo0\nfoo(0)\nqueueTool(\nfoo(?=bar)\n",
    );
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    await assert.rejects(
      invoke(tool, "missing-mode", { pattern: "foo" }),
      rejectsArgument("literal", /required/),
    );
    for (const pattern of ["(?i:^foo$)", "(?<name>foo)$"]) {
      const result = await invoke(tool, "regex", { pattern, literal: false });
      assert.match(result.content[0].text, /│foo/);
    }
    const regex = await invoke(tool, "regex-punctuation", { pattern: "foo(0)", literal: false });
    assert.match(regex.content[0].text, /│foo0/);
    assert.doesNotMatch(regex.content[0].text, /│foo\(0\)/);
    for (const pattern of ["foo(0)", "queueTool(", "foo(?=bar)"]) {
      const result = await invoke(tool, "literal", { pattern, literal: true });
      assert.ok(result.content[0].text.includes(`│${pattern}`));
    }
    const missing = await invoke(tool, "no-match", { pattern: "missing(", literal: true });
    assert.equal(reportOf(missing)?.matches, 0);
    assert.equal(missing.isError, undefined);
    await assert.rejects(
      invoke(tool, "invalid-regex", { pattern: "queueTool(", literal: false }),
      rejectsArgument("pattern", /Invalid regular expression/),
    );
    await assert.rejects(
      invoke(tool, "invalid-array", { pattern: ["queueTool(", "\\bfoo\\b"], literal: false }),
      rejectsArgument("pattern[0]", /Invalid regular expression/),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg keeps CRLF line-end anchors with regex OR matching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-crlf-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "alpha beta drop\r\nalpha beta\r\nalpha only");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const ending = await invoke(
      tool,
      "0",
      { pattern: "beta$", literal: false },
      undefined,
      undefined,
    );
    assert.match(ending.content[0].text, /fixture\.ts · 1 match/);
    assert.match(ending.content[0].text, /2#[0-9A-Z]+│alpha beta$/);
    const alternatives = await invoke(
      tool,
      "0",
      { pattern: ["beta$", "alpha only"], literal: false },
      undefined,
      undefined,
    );
    assert.match(alternatives.content[0].text, /fixture\.ts · 2 matches/);
    assert.match(alternatives.content[0].text, /3#[0-9A-Z]+│alpha only$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg finds a late OR match and respects the line limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-limit-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "foo skip\n".repeat(4096) + "foo keep\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result = await invoke(
      tool,
      "0",
      { pattern: ["foo keep", "missing"], literal: true, limit: 1 },
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /4097#[0-9A-Z]+│foo keep/);
    assert.equal(reportOf(result)?.matchLimit, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared rg runner stops and cleans up after limits, callback failures, and cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-process-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "needle\n".repeat(10_000));
    const args = [
      ...COMMON_RG_ARGS,
      "--engine=default",
      "--no-multiline",
      "--json",
      "-e",
      "needle",
      "--",
      file,
    ];
    const stopped = await runRg(rgPath, args, undefined, () => false);
    assert.equal(stopped.stopped, true);
    await assert.rejects(
      runRg(rgPath, args, undefined, () => {
        throw new Error("callback failed");
      }),
      /callback failed/,
    );
    const controller = new AbortController();
    await assert.rejects(
      runRg(rgPath, args, controller.signal, () => {
        controller.abort();
        return true;
      }),
      /Operation aborted/,
    );
    await assert.rejects(
      runRg(join(directory, "missing-rg"), [], undefined, () => true),
      /Failed to run ripgrep/,
    );
    await assert.rejects(
      probeRegex(join(directory, "missing-rg"), {
        engine: "default",
        pattern: "needle",
        multiline: false,
      }),
      /Failed to run ripgrep/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory searches respect ignores but explicit files and hidden files remain searchable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-ignore-"));
  try {
    await writeFile(join(directory, ".ignore"), "ignored.txt\n");
    const ignored = join(directory, "ignored.txt");
    await writeFile(ignored, "needle\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const normal = await invoke(
      tool,
      "0",
      { literal: true, pattern: "needle" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(normal)?.matches, 0);
    const explicit = await invoke(
      tool,
      "0",
      { literal: true, pattern: "needle", path: ignored },
      undefined,
      undefined,
    );
    assert.match(explicit.content[0].text, /ignored\.txt · 1 match/);
    const excluded = await invoke(
      tool,
      "0",
      { literal: true, pattern: "needle", path: ignored, glob: "!ignored.txt" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(excluded)?.matches, 0);
    await writeFile(join(directory, ".hidden.txt"), "needle\n");
    const hidden = await invoke(
      tool,
      "0",
      { literal: true, pattern: "needle" },
      undefined,
      undefined,
    );
    assert.match(hidden.content[0].text, /\.hidden\.txt · 1 match/);
    assert.doesNotMatch(hidden.content[0].text, /ignored\.txt · 1 match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit file paths obey ordered glob filters without inheriting ignore rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-file-glob-"));
  try {
    const kept = join(directory, "keep.ts");
    const excluded = join(directory, "drop.test.ts");
    const ignored = join(directory, "ignored.ts");
    await writeFile(join(directory, ".ignore"), "ignored.ts\n");
    await Promise.all([kept, excluded, ignored].map((path) => writeFile(path, "needle\n")));
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result: any = await invoke(
      tool,
      "0",
      {
        literal: true,
        pattern: "needle",
        path: [kept, excluded, ignored],
        glob: ["*.ts", "!**/*.test.ts"],
        outputMode: "files",
      },
      undefined,
      undefined,
    );
    const files = new Set(result.content[0].text.split("\n"));
    assert.deepEqual(files, new Set(["keep.ts", "ignored.ts"]));

    const none: any = await invoke(
      tool,
      "0",
      { literal: true, pattern: "needle", path: excluded, glob: "!**/*.test.ts" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(none)?.matches, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory traversal skips symlinks but explicitly named linked files remain searchable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-follow-"));
  try {
    const root = join(directory, "root");
    const target = join(directory, "target");
    const link = join(root, "link");
    const secondLink = join(root, "second-link");
    await mkdir(root);
    await mkdir(target);
    const targetFile = join(target, "linked.txt");
    await writeFile(targetFile, "needle\n");
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      await symlink(target, secondLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error: any) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code))
        return t.skip("symbolic link creation unavailable");
      throw error;
    }
    const grep = makeGrepOverrideWithBackend(root, DEFAULT_CONFIG, {});
    const hidden: any = await invoke(
      grep,
      "0",
      { literal: true, pattern: "needle" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(hidden)?.matches, 0);
    const found: any = await invoke(
      grep,
      "0",
      { literal: true, pattern: "needle", path: join(link, "linked.txt") },
      undefined,
      undefined,
    );
    const [header, anchored] = found.content[0].text.split("\n");
    const resultPath = header.slice(0, header.lastIndexOf(" · "));
    assert.equal(resultPath.replace(/\\/g, "/"), "link/linked.txt");
    assert.equal(found.content[0].text.match(/ · 1 match/g)?.length, 1);
    const anchor = anchored.slice(0, anchored.indexOf("│"));
    const edit: any = makeEditOverride(root, DEFAULT_CONFIG);
    await invoke(
      edit,
      "0",
      { path: resultPath, edits: [{ op: "replace", anchor, body: ["updated"] }] },
      undefined,
      undefined,
    );
    assert.equal(await readFile(targetFile, "utf8"), "updated\n");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), target);
    assert.equal((await lstat(secondLink)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real grep reports PCRE2 unbounded lookbehind as INVALID_REGEX before searching", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-lookbehind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fixture.txt"), "aaab\n");
  let searched = false;
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
    search(...args) {
      searched = true;
      return runRgSearch(...args);
    },
  });
  await expectToolFailure(
    invoke(tool, "0", { pattern: "(?<=a+)b", literal: false }),
    "INVALID_REGEX",
    (report) => {
      assert.match(report.cause?.message ?? "", /lookbehind/i);
      assert.match(report.next ?? "", /bounded length/);
    },
  );
  assert.equal(searched, false);
});

test("line-based grep uses context for display but never matches across CRLF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-lines-"));
  try {
    await writeFile(join(directory, "fixture.txt"), "alpha\r\nbeta\r\ngamma\r\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const context = await invoke(
      tool,
      "0",
      { literal: true, pattern: "alpha", context: 1 },
      undefined,
      undefined,
    );
    assert.match(context.content[0].text, /fixture\.txt · 1 match/);
    assert.match(context.content[0].text, /1#[0-9A-Z]+│alpha/);
    assert.match(context.content[0].text, /2#[0-9A-Z]+│beta/);
    assert.doesNotMatch(context.content[0].text, /3#[0-9A-Z]+│gamma/);
    for (const [pattern, literal] of [
      ["alpha\\nbeta", false],
      ["alpha\nbeta", true],
    ] as const) {
      await assert.rejects(
        invoke(tool, "0", { pattern, literal }),
        rejectsArgument("pattern", /each line.*line break/),
      );
    }
    const limited = await invoke(
      tool,
      "0",
      { literal: true, pattern: ["alpha", "beta"], outputMode: "count", limit: 1 },
      undefined,
      undefined,
    );
    assert.match(limited.content[0].text, /fixture\.txt: 1/);
    assert.equal(reportOf(limited)?.matchLimit, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline grep anchors CRLF spans and counts overlapping physical lines once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const regex = await invoke(
      tool,
      "0",
      { pattern: "alpha\\nbeta", path: file, literal: false, multiline: true },
      undefined,
      undefined,
    );
    assert.match(regex.content[0].text, /fixture\.txt · 2 matches/);
    assert.match(regex.content[0].text, /1#[0-9A-Z]+│alpha/);
    assert.match(regex.content[0].text, /2#[0-9A-Z]+│beta/);
    const literal = await invoke(
      tool,
      "0",
      { pattern: "alpha\nbeta", path: file, literal: true, multiline: true },
      undefined,
      undefined,
    );
    assert.match(literal.content[0].text, /fixture\.txt · 2 matches/);
    const overlapping = await invoke(
      tool,
      "0",
      { pattern: ["alpha\\nbeta", "beta\\ngamma"], path: file, multiline: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(overlapping.content[0].text, /fixture\.txt · 3 matches/);
    const bounded = await invoke(
      tool,
      "0",
      {
        pattern: "(?s:alpha.*gamma)",
        literal: false,
        path: file,
        multiline: true,
        outputMode: "count",
        limit: 2,
      },
      undefined,
      undefined,
    );
    assert.match(bounded.content[0].text, /fixture\.txt: 2/);
    assert.equal(reportOf(bounded)?.matches, 2);
    assert.equal(reportOf(bounded)?.files, 1);
    assert.equal(reportOf(bounded)?.matchLimit, 2);
    const files = await invoke(
      tool,
      "0",
      {
        pattern: "alpha\\nbeta",
        literal: false,
        path: file,
        multiline: true,
        outputMode: "files",
        limit: 1,
      },
      undefined,
      undefined,
    );
    assert.equal(files.content[0].text, "fixture.txt");
    assert.equal(reportOf(files)?.matchLimit, 1);
    const boundary = await invoke(
      tool,
      "0",
      { pattern: "alpha\\n", path: file, multiline: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(boundary.content[0].text, /fixture\.txt · 1 match/);
    const edit: any = makeEditOverride(directory, DEFAULT_CONFIG);
    const anchor = regex.content[0].text.match(/(2#[0-9A-Z]+)│beta/)?.[1];
    assert.ok(anchor);
    await invoke(
      edit,
      "0",
      { path: file, edits: [{ op: "replace", anchor, body: ["updated"] }] },
      undefined,
      undefined,
    );
    assert.equal(await readFile(file, "utf8"), "alpha\r\nupdated\r\ngamma\r\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline grep preserves BOM and standalone CR while normalizing CRLF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-cr-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "\uFEFFalpha\rsolo\r\nbeta\r\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result = await invoke(
      tool,
      "0",
      { pattern: "alpha\\rsolo\\nbeta", path: file, multiline: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /fixture\.txt · 2 matches/);
    assert.match(result.content[0].text, /1#[0-9A-Z]+│\uFEFFalpha␍solo/);
    assert.match(result.content[0].text, /2#[0-9A-Z]+│beta/);
    const literal = await invoke(
      tool,
      "0",
      { pattern: "alpha\rsolo\r\nbeta", path: file, multiline: true, literal: true },
      undefined,
      undefined,
    );
    assert.match(literal.content[0].text, /fixture\.txt · 2 matches/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline grep anchors empty lines and line-start zero-width matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-empty-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "alpha\r\n\r\nbeta\r\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const span = await invoke(
      tool,
      "0",
      { pattern: "alpha\\n\\nbeta", path: file, multiline: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(span.content[0].text, /fixture\.txt · 3 matches/);
    assert.match(span.content[0].text, /2#[0-9A-Z]+│\n3#[0-9A-Z]+│beta/);
    const starts = await invoke(
      tool,
      "0",
      { pattern: "^", path: file, multiline: true, literal: false },
      undefined,
      undefined,
    );
    assert.match(starts.content[0].text, /fixture\.txt · 3 matches/);
    assert.match(starts.content[0].text, /1#[0-9A-Z]+│alpha/);
    assert.match(starts.content[0].text, /3#[0-9A-Z]+│beta/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline zero-width EOF stays on the last existing physical line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-eof-"));
  try {
    const file = join(directory, "fixture.txt");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const content of ["last line", "last line\n"]) {
      await writeFile(file, content);
      const result = await invoke(
        tool,
        "0",
        { pattern: "$(?![\\s\\S])", path: file, multiline: true, literal: false },
        undefined,
        undefined,
      );
      if (content.endsWith("\n")) {
        assert.equal(reportOf(result)?.matches, 0);
      } else {
        assert.match(result.content[0].text, /fixture\.txt · 1 match/);
        assert.match(result.content[0].text, /1#[0-9A-Z]+│last line/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline grep detects changed files and propagates cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-state-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "alpha\nbeta\n");
    const changing = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
      async search(path, request, signal, onLine) {
        const result = await runRgSearch(path, request, signal, onLine);
        await writeFile(file, "alpha\nchanged\n");
        return result;
      },
    });
    await expectToolFailure(
      invoke(
        changing,
        "0",
        { pattern: "alpha\\nbeta", path: file, multiline: true, literal: false },
        undefined,
        undefined,
      ),
      "FILE_CHANGED",
    );
    await writeFile(file, "alpha\nbeta\n");
    const controller = new AbortController();
    const cancelling = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
      search(path, request, signal, onLine) {
        controller.abort();
        return runRgSearch(path, request, signal, onLine);
      },
    });
    await expectToolFailure(
      invoke(
        cancelling,
        "0",
        { pattern: "alpha\\nbeta", path: file, multiline: true, literal: false },
        controller.signal,
        undefined,
      ),
      "OPERATION_ABORTED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("files and count modes aggregate only matching lines inside the limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-output-modes-"));
  try {
    const first = join(directory, "a.txt");
    const second = join(directory, "b.txt");
    await writeFile(first, "needle needle\nneedle\n");
    await writeFile(second, "needle\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const query = { literal: true, pattern: "needle", path: [first, second], limit: 1 };
    const files = await invoke(
      tool,
      "files",
      { ...query, outputMode: "files" },
      undefined,
      undefined,
    );
    assert.match(files.content[0].text, /^(?:a|b)\.txt$/);
    assert.equal(reportOf(files)?.matchLimit, 1);
    const limited = await invoke(
      tool,
      "count",
      { ...query, outputMode: "count" },
      undefined,
      undefined,
    );
    assert.equal(reportOf(limited)?.matches, 1);
    assert.equal(reportOf(limited)?.files, 1);
    const complete = await invoke(
      tool,
      "count-all",
      { ...query, outputMode: "count", limit: 10 },
      undefined,
      undefined,
    );
    assert.equal(reportOf(complete)?.matches, 3);
    assert.equal(reportOf(complete)?.files, 2);
    const contextual = await invoke(
      tool,
      "content",
      { ...query, path: first, outputMode: "content", context: 1 },
      undefined,
      undefined,
    );
    assert.match(contextual.content[0].text, /a\.txt · 1 match/);
    assert.match(contextual.content[0].text, /2#[0-9A-Z]+│needle/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default grep rejects file changes and propagates cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-default-state-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "foo bar\n");
    const changing = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
      async search(path, request, signal, onLine) {
        const result = await runRgSearch(path, request, signal, onLine);
        await writeFile(file, "changed content\n");
        return result;
      },
    });
    await expectToolFailure(
      invoke(changing, "0", { literal: true, pattern: "foo", path: file }, undefined, undefined),
      "FILE_CHANGED",
    );

    await writeFile(file, "foo bar\n");
    const controller = new AbortController();
    const cancelling = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
      search(path, request, signal, onLine) {
        controller.abort();
        return runRgSearch(path, request, signal, onLine);
      },
    });
    await expectToolFailure(
      invoke(
        cancelling,
        "0",
        { literal: true, pattern: "foo", path: file },
        controller.signal,
        undefined,
      ),
      "OPERATION_ABORTED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned rg rejects an oversized JSONL record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-record-limit-"));
  try {
    await writeFile(join(directory, "large.txt"), `needle${"x".repeat(MAX_RG_RECORD_BYTES + 1)}\n`);
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    await expectToolFailure(
      invoke(tool, "0", { pattern: "needle", literal: true }, undefined, undefined),
      "RIPGREP_FAILED",
      (report) =>
        assert.match(
          report.message ?? "",
          new RegExp(`record exceeds ${MAX_RG_RECORD_BYTES / 1024 ** 2} MiB`),
        ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg accepts wildcard-only regexes and preserves limits and literal mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-wildcard-"));
  try {
    await writeFile(join(directory, "fixture.txt"), "first\n\n.*\n");
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const [pattern, expected] of [
      [".*", 3],
      ["^.+$", 2],
      [".?", 3],
    ] as const) {
      const result: any = await invoke(
        tool,
        "count",
        { pattern, literal: false, outputMode: "count" },
        undefined,
        undefined,
      );
      assert.equal(reportOf(result)?.matches, expected);
      assert.equal(reportOf(result)?.files, 1);
    }
    const limited: any = await invoke(
      tool,
      "limited",
      { pattern: ".*", literal: false, limit: 1 },
      undefined,
      undefined,
    );
    assert.match(limited.content[0].text, /1#[0-9A-Z]+│first/);
    assert.doesNotMatch(limited.content[0].text, /[23]#[0-9A-Z]+│/);
    const literal: any = await invoke(
      tool,
      "literal",
      { pattern: ".*", literal: true },
      undefined,
      undefined,
    );
    assert.match(literal.content[0].text, /3#[0-9A-Z]+│\.\*/);
    await assert.rejects(
      invoke(tool, "invalid", { pattern: "*", literal: false }),
      rejectsArgument("pattern", /Invalid regular expression/),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools share physical lines and anchors across text representations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-text-integration-"));
  const call = (tool: any, params: any) => invoke(tool, "0", params, undefined, undefined);
  const rows = (result: any): string[] =>
    result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line));
  try {
    const file = join(directory, "fixture.txt");
    for (const [index, before] of [
      "a\nold\n",
      "a\r\nold\r\n",
      "\uFEFFa\r\nold\nkeep\r\n",
      "a\rb\nold\n",
      "a\rb\nold",
    ].entries()) {
      await call(makeWriteOverride(directory), {
        path: file,
        content: before,
        mode: index === 0 ? "create" : "overwrite",
      });
      assert.equal(await readFile(file, "utf8"), before);
      const read = await call(makeReadOverride(directory, DEFAULT_CONFIG), { path: file });
      const grep = await call(makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {}), {
        literal: true,
        path: file,
        pattern: "old",
        context: 2,
      });
      assert.deepEqual(rows(grep), rows(read));
      if (before.includes("a\rb")) assert.match(rows(read)[0], /│a␍b$/);
      const anchor = rows(grep)[1].split("│")[0];
      const edit = await call(makeEditOverride(directory, DEFAULT_CONFIG), {
        path: file,
        edits: [{ op: "replace", anchor, body: ["new"] }],
      });
      assert.equal(await readFile(file, "utf8"), before.replace("old", "new"));
      assert.equal(edit.details.firstChangedLine, 2);
      assert.match(edit.details.diff, /^-2 old/m);
      assert.match(edit.details.diff, /^\+2 new/m);
      assert.ok(!edit.details.diff.includes("\r"));
      if (before.includes("a\rb")) assert.ok(edit.details.patch.includes(" a\rb\n"));
      const replaced = await call(makeReplaceTool(directory, DEFAULT_CONFIG), {
        path: file,
        replacements: [{ find: "new", replace: "next" }],
      });
      assert.equal(await readFile(file, "utf8"), before.replace("old", "next"));
      assert.equal(replaced.details.firstChangedLine, 2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("long-line previews preserve full-line anchors across literal and JavaScript regex queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-preview-"));
  try {
    const long = "😀界".repeat(220) + "NEEDLE" + "tail".repeat(200);
    const context = "x" + "😀".repeat(400);
    await writeFile(join(directory, "long.txt"), `${long}\r\nfollow\r\n${context}\r\n`);
    const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const params of [
      { literal: true, pattern: "NEEDLE" },
      { pattern: ["NEEDLE", "tail"], literal: true },
      { pattern: "NEEDLE(?:tail)+", literal: false },
    ]) {
      const result: any = await invoke(
        tool,
        "preview",
        { ...params, context: 2 },
        undefined,
        undefined,
      );
      const output = result.content[0].text;
      const row = output.split("\n").find((line: string) => line.startsWith("1#"));
      assert.ok(row.startsWith(`1#${computeLineHash(1, long, 4)}│[partial, columns `));
      assert.ok(row.includes("NEEDLE"));
      assert.equal(Buffer.from(row).toString("utf8"), row);
      assert.ok(
        output.includes(
          `3#${computeLineHash(3, context, 4)}│[partial, columns 1-${DEFAULT_OUTPUT_BUDGETS.grepPreviewUnits - 1}]`,
        ),
      );
      assert.equal(reportOf(result)?.linePreviewLimit, DEFAULT_OUTPUT_BUDGETS.grepPreviewUnits);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all text tools share logical CRLF matching, anchors, and mutation separators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-shared-text-"));
  try {
    const path = join(directory, "mixed.txt");
    const before = "\uFEFFhead\r\nalpha\r\nbeta\nstand\rCR\r\r\nlast";
    const write = makeWriteOverride(directory);
    const read = makeReadOverride(directory, DEFAULT_CONFIG);
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    await invoke(write, "write", { path, content: before, mode: "create" }, undefined, undefined, {
      cwd: directory,
    } as ExtensionContext);
    assert.equal(await readFile(path, "utf8"), before);
    const observed = await invoke(read, "read", { path }, undefined, undefined, {
      cwd: directory,
    } as ExtensionContext);
    assert.ok(observed.content[0].type === "text");
    const rows = observed.content[0].text
      .split("\n")
      .filter((line: string) => /^\d+#[0-9A-Z]+│/.test(line));
    for (const query of [
      { pattern: ["alpha", "beta"], literal: true },
      { pattern: "alpha|beta", literal: false },
    ]) {
      const found = await invoke(grep, "grep", { path, ...query }, undefined, undefined);
      assert.ok(found.content[0].text.includes(rows[1]), JSON.stringify(query));
      assert.ok(found.content[0].text.includes(rows[2]), JSON.stringify(query));
    }
    const contextual = await invoke(
      grep,
      "grep",
      { literal: true, path, pattern: "alpha", context: 1 },
      undefined,
      undefined,
    );
    assert.match(contextual.content[0].text, /mixed\.txt · 1 match/);
    assert.ok(contextual.content[0].text.includes(rows[1]));
    assert.ok(contextual.content[0].text.includes(rows[2]));
    const carriage = await invoke(
      grep,
      "grep",
      { path, pattern: "\\r", literal: false },
      undefined,
      undefined,
    );
    assert.ok(carriage.content[0].text.includes(rows[3]));
    assert.ok(!carriage.content[0].text.includes(rows[1]));
    const standaloneEnd = await invoke(
      grep,
      "grep",
      { path, pattern: "CR\\r$", literal: false },
      undefined,
      undefined,
    );
    assert.ok(standaloneEnd.content[0].text.includes(rows[3]));

    const expected = "\uFEFFhead\r\nA\r\nB\r\nC\nstand\rCR\r\r\nlast";
    for (const mode of ["edit", "literal", "regex"]) {
      await invoke(
        write,
        "reset",
        { path, content: before, mode: "overwrite" },
        undefined,
        undefined,
        {
          cwd: directory,
        } as ExtensionContext,
      );
      if (mode === "edit") {
        await invoke(
          makeEditOverride(directory, DEFAULT_CONFIG),
          "edit",
          {
            path,
            edits: [
              {
                op: "replace",
                anchor: rows[1].split("│")[0],
                end: rows[2].split("│")[0],
                body: ["A", "B", "C"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd: directory } as ExtensionContext,
        );
      } else {
        await invoke(
          makeReplaceTool(directory, DEFAULT_CONFIG),
          "replace",
          {
            path,
            replacements: [
              {
                find: mode === "regex" ? "alpha\\nbeta" : "alpha\r\nbeta",
                replace: "A\nB\nC",
                regex: mode === "regex",
              },
            ],
          },
          undefined,
          undefined,
          { cwd: directory } as ExtensionContext,
        );
      }
      assert.equal(await readFile(path, "utf8"), expected, mode);
    }
    // Whole-file write remains the explicit representation boundary, including EOL conversion.
    await invoke(
      write,
      "convert",
      { path, content: "alpha\nbeta\n", mode: "overwrite" },
      undefined,
      undefined,
      {
        cwd: directory,
      } as ExtensionContext,
    );
    assert.equal(await readFile(path, "utf8"), "alpha\nbeta\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visible source escapes remain readable and searchable while real CRLF stays preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-source-escapes-"));
  try {
    const path = join(directory, "escapes.ts");
    const code = 'const eol = "\\r\\n";\r\n';
    await invoke(
      makeWriteOverride(directory),
      "write",
      { path, content: code, mode: "create" },
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    const read = await invoke(
      makeReadOverride(directory, DEFAULT_CONFIG),
      "read",
      { path },
      undefined,
      undefined,
      {
        cwd: directory,
      } as ExtensionContext,
    );
    assert.ok(read.content[0].type === "text");
    assert.ok(read.content[0].text.includes(String.raw`const eol = "\r\n";`));
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const query of [
      { pattern: String.raw`\r\n`, literal: true },
      { pattern: String.raw`\\r\\n`, literal: false },
    ]) {
      const result = await invoke(grep, "grep", { path, ...query }, undefined, undefined);
      assert.ok(result.content[0].text.includes(String.raw`const eol = "\r\n";`));
    }
    const replace = makeReplaceTool(directory, DEFAULT_CONFIG);
    await invoke(
      replace,
      "literal",
      { path, replacements: [{ find: String.raw`\r\n`, replace: String.raw`\n` }] },
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    assert.equal(await readFile(path, "utf8"), 'const eol = "\\n";\r\n');
    await invoke(
      replace,
      "regex",
      { path, replacements: [{ find: String.raw`\\n`, replace: String.raw`\r\n`, regex: true }] },
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    assert.equal(await readFile(path, "utf8"), code);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("grep retains original paths and ignores unmatched invalid UTF-8 across many files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-many-files-"));
  try {
    await Promise.all(
      Array.from({ length: 70 }, (_, i) => writeFile(join(directory, `file ${i}.txt`), "--\r\n")),
    );
    await writeFile(join(directory, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result = await invoke(
      grep,
      "grep",
      { path: directory, pattern: "--", literal: true, outputMode: "count", limit: 100 },
      undefined,
      undefined,
    );
    assert.equal((result.content[0].text.match(/file \d+\.txt: 1/g) ?? []).length, 70);
    assert.doesNotMatch(result.content[0].text, /invalid\.txt|UNSUPPORTED_ENCODING/);
    assert.doesNotMatch(result.content[0].text, /hashline-grep-/);
    assert.equal(result.details?.incomplete, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NUL files are silently skipped across search scopes and output modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-nul-"));
  try {
    const binary = join(directory, "binary.txt");
    const source = Buffer.concat([
      Buffer.from("needle\r\n"),
      Buffer.alloc(65536, 97),
      Buffer.from("\0needle\n"),
    ]);
    await writeFile(binary, source);
    await writeFile(join(directory, "valid.txt"), "needle\n");
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const outputMode of ["content", "files", "count"] as const) {
      for (const multiline of [false, true]) {
        const skipped = await invoke(
          grep,
          "binary",
          { path: binary, pattern: "needle", literal: true, outputMode, multiline },
          undefined,
          undefined,
        );
        assert.equal(reportOf(skipped)?.matches, 0);
        assert.equal(reportOf(skipped)?.diagnostics, undefined);
        const result = await invoke(
          grep,
          "directory",
          { path: directory, pattern: "needle", literal: true, outputMode, multiline, limit: 1 },
          undefined,
          undefined,
        );
        assert.match(result.content[0].text, /valid\.txt/);
        assert.doesNotMatch(result.content[0].text, /binary\.txt|UNSUPPORTED_TEXT/);
        assert.equal(result.details?.incomplete, undefined);
      }
    }
    assert.deepEqual(await readFile(binary), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid UTF-8 matches use plain previews while valid files retain edit anchors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-preview-"));
  try {
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const invalid = join(directory, "invalid.txt");
    for (const separator of ["\n", "\r\n"]) {
      const source = Buffer.concat([
        Buffer.from(`before${separator}needle `),
        Buffer.from([0xff]),
        Buffer.from(`${separator}after${separator}`),
      ]);
      await writeFile(invalid, source);
      const result = await invoke(
        grep,
        "preview",
        { path: invalid, pattern: "needle", literal: true, context: 1 },
        undefined,
        undefined,
      );
      assert.match(result.content[0].text, /1│before\n2│needle �\n3│after/);
      assert.deepEqual(reportOf(result)?.invalidUtf8, ["invalid.txt"]);
      assert.doesNotMatch(result.content[0].text, /\d+#/);
      assert.equal(result.details?.incomplete, undefined);
      assert.deepEqual(await readFile(invalid), source);
    }
    await writeFile(join(directory, "valid.txt"), "needle\n");
    const mixed = await invoke(
      grep,
      "mixed",
      { path: directory, pattern: "needle", literal: true },
      undefined,
      undefined,
    );
    assert.match(mixed.content[0].text, /valid\.txt · 1 match\n1#[A-Z0-9]+│needle/);
    assert.match(mixed.content[0].text, /invalid\.txt · 1 match\n2│needle �/);
    for (const outputMode of ["files", "count"] as const) {
      const result = await invoke(
        grep,
        "summary",
        { path: directory, pattern: "needle", literal: true, outputMode },
        undefined,
        undefined,
      );
      assert.match(result.content[0].text, /invalid\.txt/);
      assert.match(result.content[0].text, /valid\.txt/);
      assert.equal(result.details?.incomplete, undefined);
    }
    const multiline = await invoke(
      grep,
      "multiline",
      { path: invalid, pattern: "needle.*\\nafter", literal: false, multiline: true },
      undefined,
      undefined,
    );
    // Malformed bytes cannot be consumed by the translated wildcard.
    assert.equal(reportOf(multiline)?.matches, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("grep paths with input shorthand or literal separators still edit the searched file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-path-roundtrip-"));
  try {
    const cases = [
      { name: "@config.txt", other: "config.txt" },
      { name: "space\u00a0file.txt", other: "space file.txt" },
      ...(process.platform === "win32"
        ? []
        : [{ name: "dir\\target.txt", other: "dir/target.txt" }]),
    ];
    for (const { name, other } of cases) {
      await t.test(name, async () => {
        const file = join(directory, name);
        const otherFile = join(directory, other);
        await mkdir(dirname(otherFile), { recursive: true });
        await writeFile(file, "needle\n");
        await writeFile(otherFile, "needle\n");
        const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
        let content = "";
        let returnedPath = "";
        for (const outputMode of ["content", "files", "count"] as const) {
          const result = await invoke(grep, "path", {
            path: pathToFileURL(file).href,
            pattern: "needle",
            literal: true,
            outputMode,
          });
          const text = result.content[0].text;
          const firstLine = text.split("\n")[0];
          returnedPath =
            outputMode === "content"
              ? firstLine.slice(0, firstLine.lastIndexOf(" · "))
              : outputMode === "count"
                ? firstLine.slice(0, firstLine.lastIndexOf(": "))
                : firstLine;
          assert.equal(canonicalPath(directory, returnedPath), file, outputMode);
          if (outputMode === "content") content = text;
        }
        const anchor = content.match(/(1#[0-9A-Z]+)│needle/)?.[1];
        assert.ok(anchor);
        await invoke(makeEditOverride(directory, DEFAULT_CONFIG), "edit", {
          path: returnedPath,
          edits: [{ op: "replace", anchor, body: ["updated"] }],
        });
        assert.equal(await readFile(file, "utf8"), "updated\n");
        assert.equal(await readFile(otherFile, "utf8"), "needle\n");
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("literal LF and CRLF queries match original valid and invalid UTF-8 files alike", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-raw-crlf-"));
  try {
    await writeFile(join(directory, "valid.txt"), "alpha\r\nbeta\r\n");
    await writeFile(
      join(directory, "invalid.txt"),
      Buffer.concat([Buffer.from("alpha\r\nbeta\r\n"), Buffer.from([0xff])]),
    );
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    for (const outputMode of ["content", "files", "count"] as const) {
      await t.test(outputMode, async () => {
        const result = await invoke(grep, "crlf", {
          path: directory,
          pattern: "alpha\r\nbeta",
          literal: true,
          multiline: true,
          outputMode,
        });
        assert.match(result.content[0].text, /(?:^|\n)valid\.txt/);
        assert.match(result.content[0].text, /(?:^|\n)invalid\.txt/);
        if (outputMode === "content") {
          assert.match(result.content[0].text, /1│alpha\n2│beta/);
          assert.match(result.content[0].text, /1#[0-9A-Z]+│alpha\n2#[0-9A-Z]+│beta/);
        } else if (outputMode === "count") {
          assert.equal(reportOf(result)?.matches, 4);
          assert.equal(reportOf(result)?.files, 2);
        }
        assert.equal(result.details?.incomplete, undefined);
        const lf = await invoke(grep, "lf", {
          path: directory,
          pattern: "alpha\nbeta",
          literal: true,
          multiline: true,
          outputMode,
        });
        assert.match(lf.content[0].text, /valid\.txt/);
        assert.match(lf.content[0].text, /invalid\.txt/);
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw-byte matches changed before revision acquisition are never confirmed by lossy previews", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-raw-revision-"));
  try {
    const file = join(directory, "invalid.txt");
    for (const separator of ["\n", "\r\n"]) {
      for (const mode of [false, true, "limited", "eof"] as const) {
        const multiline = mode !== false;
        for (const outputMode of ["content", "files", "count"] as const) {
          await t.test(`${JSON.stringify(separator)} ${mode} ${outputMode}`, async () => {
            const source = (byte: number) =>
              Buffer.concat([
                Buffer.from(`before${separator}${"x".repeat(64 * 1024)}`),
                Buffer.from([byte]),
                Buffer.from(`needle${separator}after${mode === "eof" ? "" : separator}`),
              ]);
            await writeFile(file, source(0xff));
            const changedSource =
              mode === "eof"
                ? Buffer.concat([source(0xff), Buffer.from(`tail${separator}`)])
                : mode === "limited"
                  ? Buffer.concat([
                      Buffer.from(`before${separator}${"x".repeat(64 * 1024)}`),
                      Buffer.from([0xff]),
                      Buffer.from(`needle${separator}AFTER${separator}`),
                    ])
                  : source(0xfe);
            let changed = false;
            const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
              search(path, request, signal, onLine) {
                return runRgSearch(path, request, signal, async (event) => {
                  if (!changed && JSON.parse(event).type === "match") {
                    changed = true;
                    await writeFile(file, changedSource);
                  }
                  return onLine(event);
                });
              },
            });
            const boundary = "\\n";
            await expectToolFailure(
              invoke(grep, "changed", {
                path: file,
                pattern:
                  mode === "limited"
                    ? `needle${boundary}after`
                    : mode === "eof"
                      ? `needle${boundary}after$(?![\\s\\S])`
                      : `needle${multiline ? `${boundary}after` : ""}`,
                literal: false,
                ignoreCase: false,
                multiline,
                ...(mode === "limited" || mode === "eof" ? { limit: 1 } : {}),
                outputMode,
              }),
              "FILE_CHANGED",
            );
            assert.equal(changed, true);
            assert.deepEqual(await readFile(file), changedSource);
          });
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw files lost before summary verification leave only confirmed counts and an incomplete notice", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-raw-summary-"));
  try {
    const invalid = join(directory, "invalid.txt");
    const valid = join(directory, "valid.txt");
    for (const outputMode of ["files", "count"] as const) {
      for (const keepValid of [true, false]) {
        await t.test(`${outputMode} ${keepValid}`, async () => {
          await writeFile(invalid, Buffer.concat([Buffer.from("needle "), Buffer.from([0xff])]));
          await writeFile(valid, "needle\n");
          const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
            async search(...args) {
              const result = await runRgSearch(...args);
              await rm(invalid);
              return result;
            },
          });
          const result = invoke(grep, "summary", {
            path: keepValid ? [invalid, valid] : invalid,
            pattern: "needle",
            literal: true,
            limit: keepValid ? 2 : 1,
            outputMode,
          });
          if (!keepValid) {
            await expectToolFailure(result, "SEARCH_INCOMPLETE", (report) => {
              assert.match(report.message ?? "", /No matches could be displayed/);
              assert.match(report.diagnostics ?? "", /invalid\.txt/);
            });
            return;
          }
          const summary = await result;
          assert.equal(summary.details?.incomplete, true);
          const shown = summary.content[0].text;
          assert.equal(shown, outputMode === "files" ? "valid.txt" : "valid.txt: 1");
          const report = reportOf(summary);
          assert.equal(report?.matchLimit, 2);
          assert.equal(report?.matches, 1);
          assert.equal(report?.files, 1);
          assert.match(report?.diagnostics ?? "", /Could not read .*invalid\.txt/);
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

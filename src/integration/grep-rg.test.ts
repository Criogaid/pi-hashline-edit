/**
 * Explicit integration coverage for the platform rg bundled by @vscode/ripgrep.
 * This suite is excluded from the default test script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { BASE_RG_ARGS, createLinePredicate, resolveIgnoreCase, runRg } from "../pi/rg-line-filter.ts";


test("real rg emits anchored matches from a temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-integration-"));
  try {
    const file = join(directory, "fixture.ts");
    await writeFile(file, "needle\nother\n");
    const tool = makeGrepOverrideWithBackend(directory, {});

    for (const pattern of ["needle", ["needle"]]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.match(result.content[0].text, /fixture\.ts · 1 match/);
      assert.match(result.content[0].text, /1#[0-9A-Z]+│needle/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg and line filters share case and Unicode semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-case-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO abc\nfoo BAR\nfoo bar\nK zip\nk zip\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    for (const ignoreCase of [undefined, true, false]) {
      const expectedCount = ignoreCase === false ? 2 : 3;
      for (const query of [
        { pattern: "foo\\S*" },
        { pattern: ["foo\\S*", "\\S+"], matchMode: "all" },
      ]) {
        const result: any = await tool.execute("0", { ...query, ignoreCase }, undefined, undefined);
        assert.match(result.content[0].text, new RegExp(`fixture\\.ts · ${expectedCount} matches`));
        assert.equal(result.content[0].text.includes("FOO abc"), ignoreCase !== false);
      }
      const excluded: any = await tool.execute("0", {
        pattern: "foo\\S*", excludePattern: "bar", ignoreCase,
      }, undefined, undefined);
      assert.match(excluded.content[0].text, /fixture\.ts · 1 match/);
      assert.ok(excluded.content[0].text.includes(ignoreCase === false ? "foo BAR" : "FOO abc"));
    }
    const unicodeAll: any = await tool.execute("0", {
      pattern: ["k", "zip"], matchMode: "all",
    }, undefined, undefined);
    assert.match(unicodeAll.content[0].text, /fixture\.ts · 2 matches/);
    assert.ok(unicodeAll.content[0].text.includes("K zip"));

    const unicodeExcluded: any = await tool.execute("0", {
      pattern: "zip", excludePattern: "k",
    }, undefined, undefined);
    assert.equal(unicodeExcluded.content[0].text, "No matches found");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg resolves regex-aware smart-case decisions", async () => {
  const cases = new Map<string, boolean>([
    ["foo", true],
    ["Foo", false],
    ["foo\\S*", true],
    ["foo\\D+", true],
    ["foo\\W+", true],
    ["foo\\p{Lu}*", true],
    ["(?P<UPPER>foo)$", true],
    ["foo[A-Z]", false],
    ["\\x66oo", true],
    ["\\x46oo", false],
    ["\\w", false],
    ["\\p{Lu}", false],
  ]);
  for (const [pattern, expected] of cases) {
    assert.equal(await resolveIgnoreCase(rgPath!, [pattern], false, undefined), expected, pattern);
  }
  assert.equal(await resolveIgnoreCase(rgPath!, ["foo\\S*"], true, undefined), false);
  assert.equal(await resolveIgnoreCase(rgPath!, ["(a)", "Foo"], false, undefined), false);
});

test("real rg owns AND and exclusion regex semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-filter-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO abc\nfoo BAR\nfoo bar\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    const rustSyntax: any = await tool.execute("0", {
      pattern: ["(?P<name>foo)\\S*", "BAR"],
      matchMode: "all",
    }, undefined, undefined);
    assert.match(rustSyntax.content[0].text, /│foo BAR/);
    assert.doesNotMatch(rustSyntax.content[0].text, /│foo bar/);

    await assert.rejects(
      tool.execute("0", {
        pattern: "missing",
        excludePattern: "queueTool(",
        literal: false,
      }, undefined, undefined),
      /regex parse error/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned rg processes ignore RIPGREP_CONFIG_PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-config-"));
  const previous = process.env.RIPGREP_CONFIG_PATH;
  try {
    const config = join(directory, "ripgreprc");
    await writeFile(config, "--ignore-case\n--fixed-strings\n--invert-match\n--pcre2\n");
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nbar\n");
    process.env.RIPGREP_CONFIG_PATH = config;
    const tool = makeGrepOverrideWithBackend(directory, {});
    const result: any = await tool.execute("0", {
      pattern: ["^foo$", "foo"],
      matchMode: "all",
    }, undefined, undefined);
    assert.match(result.content[0].text, /fixture\.ts · 2 matches/);
    assert.match(result.content[0].text, /│foo/);
    assert.match(result.content[0].text, /│FOO/);
    assert.doesNotMatch(result.content[0].text, /│bar/);
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg validates its own regex syntax and limits automatic literal fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-regex-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nqueueTool(\nfoo(?=bar)\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    for (const pattern of ["(?i)^foo$", "(?P<name>foo)$"]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.match(result.content[0].text, /│foo/);
      assert.doesNotMatch(result.content[0].text, /Invalid regex/);
    }
    for (const pattern of ["queueTool(", "foo(?=bar)"]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.ok(result.content[0].text.includes(`│${pattern}`));
      assert.match(result.content[0].text, /Invalid regex; searched all patterns as literal text/);
      await assert.rejects(
        tool.execute("0", { pattern, literal: false }, undefined, undefined),
        /regex parse error/,
      );
    }
    const missing: any = await tool.execute("0", { pattern: "missing(" }, undefined, undefined);
    assert.match(missing.content[0].text, /No matches found\n\n\[Invalid regex/);
    const explicit: any = await tool.execute("0", { pattern: "queueTool(", literal: true }, undefined, undefined);
    assert.match(explicit.content[0].text, /│queueTool\(/);
    assert.doesNotMatch(explicit.content[0].text, /Invalid regex/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg preserves CRLF end anchors in main searches, AND filters, and exclusions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-crlf-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "alpha beta drop\r\nalpha beta\r\nalpha only");
    const tool = makeGrepOverrideWithBackend(directory, {});
    for (const pattern of [["alpha", "beta$"], ["beta$", "alpha"], ["beta$"]]) {
      const result = await tool.execute("0", { pattern, matchMode: "all" }, undefined, undefined);
      assert.match(result.content[0].text, /fixture\.ts · 1 match/);
      assert.match(result.content[0].text, /2#[0-9A-Z]+│alpha beta$/);
    }
    const excluded = await tool.execute("0", {
      pattern: "alpha", excludePattern: "beta$",
    }, undefined, undefined);
    assert.match(excluded.content[0].text, /fixture\.ts · 2 matches/);
    assert.doesNotMatch(excluded.content[0].text, /2#[0-9A-Z]+│/);
    assert.match(excluded.content[0].text, /3#[0-9A-Z]+│alpha only$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg reaches a late survivor with two bounded filter invocations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-batches-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "foo skip\n".repeat(4096) + "foo keep\n");
    let invocations = 0;
    const tool = makeGrepOverrideWithBackend(directory, {
      createLinePredicate(...args) {
        const predicate = createLinePredicate(...args);
        return async (lines) => {
          invocations++;
          return predicate(lines);
        };
      },
    });
    const result = await tool.execute("0", {
      pattern: "foo", excludePattern: "skip", literal: true, ignoreCase: false, limit: 1,
    }, undefined, undefined);
    assert.match(result.content[0].text, /4097#[0-9A-Z]+│foo keep/);
    assert.equal(invocations, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared rg runner stops and cleans up after limits, callback failures, and cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-process-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "needle\n".repeat(10_000));
    const args = [...BASE_RG_ARGS, "--json", "-e", "needle", "--", file];
    const stopped = await runRg(rgPath, args, undefined, () => false);
    assert.equal(stopped.stopped, true);
    await assert.rejects(runRg(rgPath, args, undefined, () => {
      throw new Error("callback failed");
    }), /callback failed/);
    const controller = new AbortController();
    await assert.rejects(runRg(rgPath, args, controller.signal, () => {
      controller.abort();
      return true;
    }), /Operation aborted/);
    await assert.rejects(runRg(join(directory, "missing-rg"), [], undefined, () => true), /Failed to run ripgrep/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

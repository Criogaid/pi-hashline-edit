/**
 * Explicit integration coverage for the platform rg bundled by @vscode/ripgrep.
 * This suite is excluded from the default test script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { makeReadOverride } from "../pi/read-tool.ts";
import { makeWriteOverride } from "../pi/write-tool.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { COMMON_RG_ARGS, createLinePredicate, resolveIgnoreCase, runRg } from "../pi/rg-line-filter.ts";

const REGEX_MODE = { engine: "default", multiline: false, literal: false } as const;

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
    assert.equal(await resolveIgnoreCase(rgPath!, [pattern], REGEX_MODE, undefined), expected, pattern);
  }
  assert.equal(await resolveIgnoreCase(rgPath!, ["foo\\S*"], { ...REGEX_MODE, literal: true }, undefined), false);
  assert.equal(await resolveIgnoreCase(rgPath!, ["(a)", "Foo"], REGEX_MODE, undefined), false);
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
    const args = [...COMMON_RG_ARGS, "--engine=default", "--no-multiline", "--json", "-e", "needle", "--", file];
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

test("noIgnore searches ignored files while explicit excluding globs still apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-ignore-"));
  try {
    await writeFile(join(directory, ".ignore"), "ignored.txt\n");
    await writeFile(join(directory, "ignored.txt"), "needle\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    const normal: any = await tool.execute("0", { pattern: "needle" }, undefined, undefined);
    assert.equal(normal.content[0].text, "No matches found");
    const included: any = await tool.execute("0", { pattern: "needle", noIgnore: true }, undefined, undefined);
    assert.match(included.content[0].text, /ignored\.txt · 1 match/);
    const excluded: any = await tool.execute("0", { pattern: "needle", noIgnore: true, glob: "!ignored.txt" }, undefined, undefined);
    assert.equal(excluded.content[0].text, "No matches found");
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
    const tool = makeGrepOverrideWithBackend(directory, {});
    const result: any = await tool.execute("0", {
      pattern: "needle",
      path: [kept, excluded, ignored],
      glob: ["*.ts", "!**/*.test.ts"],
      outputMode: "files",
    }, undefined, undefined);
    const files = new Set(result.content[0].text.split("\n"));
    assert.deepEqual(files, new Set(["keep.ts", "ignored.ts"]));

    const none: any = await tool.execute("0", {
      pattern: "needle", path: excluded, glob: "!**/*.test.ts",
    }, undefined, undefined);
    assert.equal(none.content[0].text, "No matches found");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("follow returns a resolved target path that edit can update without replacing the link", async (t) => {
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
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("symbolic link creation unavailable");
      throw error;
    }
    const grep = makeGrepOverrideWithBackend(root, {});
    const hidden: any = await grep.execute("0", { pattern: "needle" }, undefined, undefined);
    assert.equal(hidden.content[0].text, "No matches found");
    const found: any = await grep.execute("0", { pattern: "needle", follow: true }, undefined, undefined);
    const [header, anchored] = found.content[0].text.split("\n");
    const resultPath = header.slice(0, header.lastIndexOf(" · "));
    assert.equal(resultPath, await realpath(targetFile));
    assert.equal(found.content[0].text.match(/ · 1 match/g)?.length, 1);
    const anchor = anchored.slice(0, anchored.indexOf("│"));
    const edit: any = makeEditOverride(root);
    await edit.execute("0", { path: resultPath, edits: [{ op: "replace", anchor, body: ["updated"] }] }, undefined, undefined);
    assert.equal(await readFile(targetFile, "utf8"), "updated\n");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), target);
    assert.equal((await lstat(secondLink)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PCRE2 applies to main, AND, exclusion, backreference, and inherited smart-case matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-pcre2-"));
  try {
    await writeFile(join(directory, "fixture.txt"), "FOO abc\nfoo BAR\nfoobar\nfoofoo\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    const main: any = await tool.execute("0", { pattern: "foo(?=bar)", pcre2: true }, undefined, undefined);
    assert.match(main.content[0].text, /│foobar/);
    const all: any = await tool.execute("0", { pattern: ["foo", "(?<=foo)bar"], matchMode: "all", pcre2: true }, undefined, undefined);
    assert.match(all.content[0].text, /fixture\.txt · 1 match/);
    assert.match(all.content[0].text, /│foobar/);
    const excluded: any = await tool.execute("0", { pattern: "foo", excludePattern: "(?<=foo)bar", pcre2: true }, undefined, undefined);
    assert.doesNotMatch(excluded.content[0].text, /│foobar/);
    const backreference: any = await tool.execute("0", { pattern: "(foo)\\1", pcre2: true }, undefined, undefined);
    assert.match(backreference.content[0].text, /│foofoo/);
    const inherited: any = await tool.execute("0", { pattern: "foo\\S*", excludePattern: "bar", pcre2: true }, undefined, undefined);
    assert.match(inherited.content[0].text, /│FOO abc/);
    assert.doesNotMatch(inherited.content[0].text, /│foo BAR/);
    await assert.rejects(tool.execute("0", { pattern: "(", pcre2: true }, undefined, undefined), /PCRE2: error compiling pattern/);
    await assert.rejects(tool.execute("0", { pattern: "foo", pcre2: true, literal: true }, undefined, undefined), /cannot be combined/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiline combines physical line sets for all, exclusion, limit, and PCRE2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-multiline-"));
  try {
    await writeFile(join(directory, "fixture.txt"), "alpha\r\nbeta\r\ngamma\r\n");
    await writeFile(join(directory, "eof.txt"), "last line");
    const tool = makeGrepOverrideWithBackend(directory, {});
    const match: any = await tool.execute("0", { pattern: "alpha\\r?\\nbeta", multiline: true, literal: false }, undefined, undefined);
    assert.match(match.content[0].text, /fixture\.txt · 2 matches/);
    assert.match(match.content[0].text, /1#[0-9A-Z]+│alpha/);
    assert.match(match.content[0].text, /2#[0-9A-Z]+│beta/);
    const all: any = await tool.execute("0", {
      pattern: ["alpha\\r?\\nbeta", "beta\\r?\\ngamma"], matchMode: "all", multiline: true, literal: false,
    }, undefined, undefined);
    assert.match(all.content[0].text, /fixture\.txt · 1 match/);
    assert.match(all.content[0].text, /2#[0-9A-Z]+│beta/);
    const excluded: any = await tool.execute("0", {
      pattern: "alpha\\r?\\nbeta", excludePattern: "beta", multiline: true, literal: false,
    }, undefined, undefined);
    assert.match(excluded.content[0].text, /fixture\.txt · 1 match/);
    assert.match(excluded.content[0].text, /1#[0-9A-Z]+│alpha/);
    const limited: any = await tool.execute("0", {
      pattern: "(?s)alpha.*gamma", multiline: true, pcre2: true, limit: 2, outputMode: "count",
    }, undefined, undefined);
    assert.match(limited.content[0].text, /fixture\.txt: 2/);
    assert.match(limited.content[0].text, /2 matches limit reached/);
    const eof: any = await tool.execute("0", { pattern: "\\z", path: "eof.txt", multiline: true, pcre2: true }, undefined, undefined);
    assert.match(eof.content[0].text, /1#[0-9A-Z]+│last line/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("complex searches reject file changes and propagate cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-complex-state-"));
  try {
    const file = join(directory, "fixture.txt");
    await writeFile(file, "foo bar\n");
    let scans = 0;
    const changing = makeGrepOverrideWithBackend(directory, {
      async runRg(path, args, signal, onLine) {
        const result = await runRg(path, args, signal, onLine);
        if (args.includes("--threads=1") && scans++ === 0) await writeFile(file, "changed content\n");
        return result;
      },
    });
    await assert.rejects(changing.execute("0", {
      pattern: ["foo", "bar"], matchMode: "all", pcre2: true, ignoreCase: false,
    }, undefined, undefined), /File changed during search/);

    await writeFile(file, "foo bar\n");
    const controller = new AbortController();
    const cancelling = makeGrepOverrideWithBackend(directory, {
      runRg(path, args, signal, onLine) {
        if (args.includes("--threads=1")) controller.abort();
        return runRg(path, args, signal, onLine);
      },
    });
    await assert.rejects(cancelling.execute("0", {
      pattern: "foo(?= bar)", pcre2: true, ignoreCase: false,
    }, controller.signal, undefined), /Operation aborted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned rg rejects an oversized JSONL record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-record-limit-"));
  try {
    await writeFile(join(directory, "large.txt"), `needle${"x".repeat(17 * 1024 * 1024)}\n`);
    const tool = makeGrepOverrideWithBackend(directory, {});
    await assert.rejects(tool.execute("0", { pattern: "needle", literal: true }, undefined, undefined), /record exceeds 16 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg accepts wildcard-only regexes and preserves limits and literal mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-wildcard-"));
  try {
    await writeFile(join(directory, "fixture.txt"), "first\n\n.*\n");
    const tool = makeGrepOverrideWithBackend(directory, {});
    for (const [pattern, expected] of [[".*", 3], ["^.+$", 2], [".?", 3]] as const) {
      const result: any = await tool.execute("count", { pattern, outputMode: "count" }, undefined, undefined);
      assert.match(result.content[0].text, new RegExp(`Total: ${expected} matches in 1 file`));
    }
    const limited: any = await tool.execute("limited", { pattern: ".*", limit: 1 }, undefined, undefined);
    assert.match(limited.content[0].text, /1#[0-9A-Z]+│first/);
    assert.doesNotMatch(limited.content[0].text, /[23]#[0-9A-Z]+│/);
    const literal: any = await tool.execute("literal", { pattern: ".*", literal: true }, undefined, undefined);
    assert.match(literal.content[0].text, /3#[0-9A-Z]+│\.\*/);
    await assert.rejects(tool.execute("invalid", { pattern: "*", literal: false }, undefined, undefined), /regex parse error/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools share physical lines and anchors across text representations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-text-integration-"));
  const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);
  const rows = (result: any): string[] => result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line));
  try {
    const file = join(directory, "fixture.txt");
    for (const before of [
      "a\nold\n",
      "a\r\nold\r\n",
      "\uFEFFa\r\nold\nkeep\r\n",
      "a\rb\nold\n",
      "a\rb\nold",
    ]) {
      await call(makeWriteOverride(directory), { path: file, content: before });
      assert.equal(await readFile(file, "utf8"), before);
      const read = await call(makeReadOverride(directory), { path: file });
      const grep = await call(makeGrepOverrideWithBackend(directory, {}), { path: file, pattern: "old", context: 2 });
      assert.deepEqual(rows(grep), rows(read));
      if (before.includes("a\rb")) assert.match(rows(read)[0], /│a␍b$/);
      const anchor = rows(grep)[1].split("│")[0];
      const edit = await call(makeEditOverride(directory), { path: file, edits: [{ op: "replace", anchor, body: ["new"] }] });
      assert.equal(await readFile(file, "utf8"), before.replace("old", "new"));
      assert.equal(edit.details.firstChangedLine, 2);
      assert.match(edit.details.diff, /^-2 old/m);
      assert.match(edit.details.diff, /^\+2 new/m);
      assert.ok(!edit.details.diff.includes("\r"));
      if (before.includes("a\rb")) assert.ok(edit.details.patch.includes(" a\rb\n"));
      const editedRead = await call(makeReadOverride(directory), { path: file });
      assert.equal(rows(edit)[0], rows(editedRead)[1].split("│")[0]);
      const replaced = await call(makeReplaceTool(directory), { path: file, find: "new", replace: "next" });
      assert.equal(await readFile(file, "utf8"), before.replace("old", "next"));
      assert.equal(replaced.details.firstChangedLine, 2);
      const replacedRead = await call(makeReadOverride(directory), { path: file });
      assert.equal(rows(replaced)[0], rows(replacedRead)[1].split("│")[0]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

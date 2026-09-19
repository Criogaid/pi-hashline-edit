/**
 * Explicit real-ripgrep integration coverage. This is excluded from the default
 * test script and never delegates to Pi's built-in grep/download path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";

async function findPathRg(): Promise<string | null> {
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "rg.exe" : "rg");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const rgPath = await findPathRg();

test("real rg emits anchored matches from a temporary directory", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-integration-"));
  try {
    const file = join(directory, "fixture.ts");
    await writeFile(file, "needle\nother\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });

    for (const pattern of ["needle", ["needle"]]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.match(result.content[0].text, /fixture\.ts · 1 match/);
      assert.match(result.content[0].text, /1#[0-9A-Z]+│needle/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg and line filters share case decisions for uppercase regex escapes", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-case-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO abc\nfoo BAR\nfoo bar\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
    for (const ignoreCase of [undefined, true, false]) {
      const expectedCount = ignoreCase === true ? 3 : 2;
      for (const query of [
        { pattern: "foo\\S*" },
        { pattern: ["foo\\S*", "\\S+"], matchMode: "all" },
      ]) {
        const result: any = await tool.execute("0", { ...query, ignoreCase }, undefined, undefined);
        assert.match(result.content[0].text, new RegExp(`fixture\\.ts · ${expectedCount} matches`));
        assert.equal(result.content[0].text.includes("FOO abc"), ignoreCase === true);
      }
      const excluded: any = await tool.execute("0", {
        pattern: "foo\\S*", excludePattern: "bar", ignoreCase,
      }, undefined, undefined);
      assert.match(excluded.content[0].text, /fixture\.ts · 1 match/);
      assert.ok(excluded.content[0].text.includes(ignoreCase === true ? "FOO abc" : "foo BAR"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg validates its own regex syntax and limits automatic literal fallback", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-regex-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nqueueTool(\nfoo(?=bar)\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
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

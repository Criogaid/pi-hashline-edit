import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { probeRegex } from "../pi/rg-process.ts";
import { callTool } from "../pi/tool-call.testing.ts";

interface RegexCase {
  readonly name: string;
  readonly patterns: readonly string[];
  readonly source: string;
  readonly ignoreCase: boolean;
  readonly multilineOnly?: boolean;
}

// Count physical LF lines, even when JS anchors also match beside a standalone CR.
function jsLines(
  source: string,
  patterns: readonly string[],
  ignoreCase: boolean,
  multiline: boolean,
) {
  const lines = new Set<number>();
  const flags = `m${ignoreCase ? "i" : ""}`;
  if (!multiline) {
    source.split("\n").forEach((line, index) => {
      if (patterns.some((pattern) => new RegExp(pattern, flags).test(line))) lines.add(index + 1);
    });
    return [...lines].sort((a, b) => a - b);
  }
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  for (const pattern of patterns) {
    for (const match of source.matchAll(new RegExp(pattern, `${flags}g`))) {
      const start = match.index;
      const end = start + Math.max(match[0].length - 1, 0);
      for (let line = lineAt(start); line <= lineAt(end); line++) lines.add(line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

const cases: readonly RegexCase[] = [
  {
    name: "standalone CR anchors",
    patterns: ["^solo$"],
    source: "head\rsolo\ntail",
    ignoreCase: false,
  },
  { name: "standalone CR atom", patterns: ["\\r"], source: "head\rsolo\ntail", ignoreCase: false },
  { name: "dot excludes CR", patterns: ["a.b"], source: "a\rb\naxb\nab", ignoreCase: false },
  { name: "sigma folding", patterns: ["^σ$"], source: "σ\nς\nΣ\ns", ignoreCase: true },
  { name: "ASCII k excludes Kelvin", patterns: ["^k$"], source: "k\nK\nK", ignoreCase: true },
  { name: "Kelvin excludes ASCII k", patterns: ["^K$"], source: "k\nK\nK", ignoreCase: true },
  {
    name: "ASCII character sets",
    patterns: ["^\\w+\\d$"],
    source: "abc1\nσ1\n_2\nabc١",
    ignoreCase: false,
  },
  { name: "lookaround", patterns: ["(?<=a)b(?=c)"], source: "abc\nabd\nzbc", ignoreCase: false },
  {
    name: "backreference",
    patterns: ["^(a+)\\1$"],
    source: "aa\naaaa\naaa\nbb",
    ignoreCase: false,
  },
  { name: "forward backreference", patterns: ["^\\1(a)$"], source: "a\naa\nb", ignoreCase: false },
  { name: "unset group", patterns: ["^(a|(b))\\2c$"], source: "ac\nbbc\nabc", ignoreCase: false },
  {
    name: "named backreference",
    patterns: ["^(?<word>a+)\\k<word>$"],
    source: "aa\naaa\naaaa",
    ignoreCase: false,
  },
  {
    name: "capture numbers in OR",
    patterns: ["^(a)\\1$", "^(b)\\1$"],
    source: "aa\nbb\nab",
    ignoreCase: false,
  },
  {
    name: "modifier groups",
    patterns: ["^(?i:foo)(?-i:BAR)$"],
    source: "FOOBAR\nfooBAR\nFoObar",
    ignoreCase: false,
  },
  {
    name: "remove global ignoreCase",
    patterns: ["^(?-i:foo)(?i:bar)$"],
    source: "fooBAR\nFOObar\nfoobar",
    ignoreCase: true,
  },
  {
    name: "line OR",
    patterns: ["^alpha$", "^beta$"],
    source: "alpha\nbeta\ngamma",
    ignoreCase: false,
  },
  {
    name: "LF view spans",
    patterns: ["alpha\\nbeta"],
    source: "alpha\nbeta\ngamma",
    ignoreCase: false,
    multilineOnly: true,
  },
  {
    name: "overlapping OR spans",
    patterns: ["alpha\\nbeta", "beta\\ngamma"],
    source: "alpha\nbeta\ngamma",
    ignoreCase: false,
    multilineOnly: true,
  },
  {
    name: "dotAll modifier",
    patterns: ["(?s:alpha.*gamma)"],
    source: "alpha\nbeta\ngamma",
    ignoreCase: false,
    multilineOnly: true,
  },
];

test("real grep matches V8 on the LF view across engines, case modes, and line endings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-equivalence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const scenario of cases) {
    for (const separator of ["\n", "\r\n"]) {
      for (const multiline of scenario.multilineOnly ? [true] : [false, true]) {
        await t.test(
          `${scenario.name} ${JSON.stringify(separator)} multiline=${multiline}`,
          async () => {
            const raw = scenario.source.replaceAll("\n", separator);
            await writeFile(path, raw);
            const expected = jsLines(
              raw.replaceAll("\r\n", "\n"),
              scenario.patterns,
              scenario.ignoreCase,
              multiline,
            );
            const result = await callTool(tool, {
              path,
              pattern: [...scenario.patterns],
              literal: false,
              ignoreCase: scenario.ignoreCase,
              multiline,
            });
            assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
            const body = result.content[0];
            assert.ok(body.type === "text");
            const actual = [...body.text.matchAll(/^(\d+)#[0-9A-Z]+│/gm)].map((match) =>
              Number(match[1]),
            );
            assert.deepEqual(actual, expected);
            assert.equal(reportOf(result)?.matches, expected.length);
          },
        );
      }
    }
  }
});

test("real grep wildcard cannot cross malformed UTF-8 bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  await writeFile(
    path,
    Buffer.concat([Buffer.from("a"), Buffer.from([0xff]), Buffer.from("b\naxb\n")]),
  );
  for (const pattern of ["a.b", "(?=a)a.b"]) {
    const result = await callTool(tool, { path, pattern, literal: false, ignoreCase: false });
    assert.equal(result.isError, undefined);
    assert.equal(reportOf(result)?.matches, 1);
    const body = result.content[0];
    assert.ok(body.type === "text");
    assert.match(body.text, /2│axb/);
    assert.doesNotMatch(body.text, /1│|\d+#/);
  }
});

test("real grep probe compiles translated matchers on empty input and propagates cancellation", async () => {
  for (const [engine, pattern, code] of [
    ["default", "^$", 1],
    ["default", "needle", 1],
    ["pcre2", "(?=needle)needle", 1],
    ["pcre2", "(?<=a+)b", 2],
  ] as const) {
    const result = await probeRegex(rgPath, { engine, pattern, multiline: false });
    assert.equal(result.code, code);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    probeRegex(
      rgPath,
      { engine: "default", pattern: "needle", multiline: false },
      controller.signal,
    ),
    /Operation aborted/,
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rejectsArgument } from "../pi/argument-error.testing.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { unsupportedByHost } from "../testing/regex-host.testing.ts";

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
  {
    name: "BMP class excludes CR",
    patterns: ["a[A-Za-z]b"],
    source: "a\rb\naxb\nab",
    ignoreCase: false,
  },
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
    name: "BMP class spans lines",
    patterns: ["alpha[\\w\\s]*gamma"],
    source: "alpha\nbeta\ngamma",
    ignoreCase: false,
    multilineOnly: true,
  },
  {
    name: "Unicode line separator anchors",
    patterns: ["^solo$"],
    source: "head\u2028solo\u2029tail",
    ignoreCase: false,
  },
  {
    name: "standalone CR in whitespace",
    patterns: ["head\\ssolo"],
    source: "head\rsolo\nhead solo",
    ignoreCase: false,
  },
  {
    name: "standalone CR in mixed class",
    patterns: ["head[a\\r]solo"],
    source: "head\rsolo\nheadasolo",
    ignoreCase: false,
  },
  {
    name: "scoped m removal excludes Unicode line boundaries",
    patterns: ["(?-m:^solo$)"],
    source: "head\u2028solo\u2029tail\nsolo",
    ignoreCase: false,
  },
  {
    name: "negated BMP class preserves case folding without splitting surrogate pairs",
    patterns: ["^[^a\\uD800-\\uDFFF]$"],
    source: "a\nA\nb\n😀\né",
    ignoreCase: true,
  },
  {
    name: "grouped supplementary literals retain UTF-16 sequence semantics",
    patterns: ["^(?:😀)+$"],
    source: "😀\n😀😀\na",
    ignoreCase: false,
  },
  ...(
    [
      ["UTF-16 dot width", "^..$", "😀\nab\na\n😀😀", false],
      ["negated digit set", "^\\D{2}$", "😀\nab\n12", false],
      ["negated word set", "^\\W{2}$", "😀\n!!\nab", false],
      ["negated space set", "^\\S{2}$", "😀\nab\n a", false],
      ["all code units", "^[\\s\\S]{2}$", "😀\nab\na", false],
      ["surrogate class", "[😀]", "😀\n😁\n🥳\na", false],
      ["surrogate capture and reference", "^(\\uD83D).\\1.$", "😀😁\n😀😀\n🥳😀", false],
      ["ungrouped supplementary quantifier", "^😀+$", "😀\n😀😀\na", false],
      ["greedy and lazy dot", "a.*?b", "a😀b\naab\nac", false],
      ["scoped dotAll", "(?s:^a.*b$)", "a\nb\na😀b\nx", false],
      ["capture reset after alternate repetition", "^(?:(a)|b)+\\1$", "aba\nab\naa\na", false],
      ["capture reset after optional repetition", "^(?:(a)?b)+\\1$", "abba\nabb\naba\nb", false],
      ["backward capture greediness", "(?<=([ab]+)([bc]+))\\1", "abca\nabcb\na", false],
      ["negative unbounded lookbehind", "(?<!a+)b", "ab\nb\ncab\ncb", false],
      ["forward reference in lookbehind", "(?<=\\1(a))b", "ab\naab\nb", false],
      ["caseless non-ASCII backreference", "^(σ)\\1$", "σς\nΣσ\nσσ\nss", true],
      ["case folding does not expand characters", "^(ß)\\1$", "ßß\nßSS\nss", true],
      ["legacy quantified lookahead", "(?=a)?b", "b\nab\na", false],
      ["negative assertion leaves capture unset", "(?!(a))\\1b", "b\nab\na", false],
      [
        "duplicate names in disjoint alternatives",
        "(?:(?<x>a)|(?<x>b))\\k<x>",
        "aa\nbb\nab",
        false,
      ],
      ["JS identity escapes are not PCRE syntax", "\\K\\R\\A\\z", "KRAz\nother", false],
      ["empty default-engine matches", "(?:)", "\n\na", false],
      ["consecutive empty lookahead matches", "(?=^$)", "\n\n\na", false],
    ] as const
  ).map(([name, pattern, source, ignoreCase]) => ({
    name,
    patterns: [pattern],
    source,
    ignoreCase,
  })),
];

test("regex and case modes across line endings → real grep agrees with native V8", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-equivalence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const scenario of cases) {
    for (const separator of ["\n", "\r\n"]) {
      for (const multiline of scenario.multilineOnly ? [true] : [false, true]) {
        await t.test(
          `${scenario.name} ${JSON.stringify(separator)} multiline=${multiline}`,
          { skip: unsupportedByHost(scenario.patterns) },
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

test("malformed UTF-8 → character classes match replacement characters in the lossy view", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  await writeFile(
    path,
    Buffer.concat([Buffer.from("a"), Buffer.from([0xff]), Buffer.from("b\naxb\n")]),
  );
  for (const pattern of [
    "a[\\u0001-\\uD7FF\\uE000-\\uFFFF]b",
    "(?=a)a[\\u0001-\\uD7FF\\uE000-\\uFFFF]b",
  ]) {
    const result = await callTool(tool, { path, pattern, literal: false, ignoreCase: false });
    assert.equal(result.isError, undefined);
    assert.equal(reportOf(result)?.matches, 2);
    const body = result.content[0];
    assert.ok(body.type === "text");
    assert.match(body.text, /2│axb/);
    assert.match(body.text, /1│a�b/);
    assert.doesNotMatch(body.text, /\d+#/);
  }
});

test("backreference regression: a capture spanning mixed line endings → matches the LF view", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-grep-backreference-"));
  try {
    const path = join(dir, "mixed.txt");
    await writeFile(path, "a\r\na\n");
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {});
    const result = await callTool(tool, {
      path,
      pattern: "(a\\n)\\1",
      literal: false,
      multiline: true,
      ignoreCase: false,
    });
    assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
    assert.equal(reportOf(result)?.matches, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backreference regression: ignoreCase with an ASCII capture → does not match the Kelvin sign", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-grep-backreference-"));
  try {
    const path = join(dir, "casefold.txt");
    await writeFile(path, "kK\n");
    const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {});
    const result = await callTool(tool, {
      path,
      pattern: "(k)\\1",
      literal: false,
      ignoreCase: true,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(reportOf(result)?.matches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zero-maximum quantifiers → real grep matches the active capture", async (t) => {
  const cases = [
    {
      name: "multiline newline repeated zero times → matches aa",
      pattern: "(a\\n{0})\\1",
      source: "aa\n",
      multiline: true,
      ignoreCase: false,
    },
    {
      name: "caseless non-ASCII text repeated zero times → matches AA",
      pattern: "(aé{0})\\1",
      source: "AA\n",
      multiline: false,
      ignoreCase: true,
    },
  ];
  for (const { name, pattern, source, multiline, ignoreCase } of cases) {
    await t.test(name, async () => {
      const dir = await mkdtemp(join(tmpdir(), "hashline-grep-zero-maximum-"));
      try {
        const path = join(dir, "input.txt");
        await writeFile(path, source);
        const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {});
        const result = await callTool(tool, {
          path,
          pattern,
          literal: false,
          multiline,
          ignoreCase,
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.equal(reportOf(result)?.matches, 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("JS syntax boundary rejects rg-only syntax and executes constructs requiring JS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-grep-strict-js-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "input.txt");
  await writeFile(path, "😀\naba\nab\n");
  const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {});
  await assert.rejects(
    () => callTool(tool, { path, pattern: "(?i)abc", literal: false }),
    rejectsArgument("pattern"),
  );
  for (const pattern of [
    "^..$",
    "^[^a]{2}$",
    "^[😀]$",
    "^(?:(a)|b)+\\1$",
    "(?<=(a)\\1)b",
    "(?<=(a))b\\1",
  ]) {
    await t.test(pattern, async () => {
      const result = await callTool(tool, { path, pattern, literal: false, ignoreCase: false });
      assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
      assert.equal(
        reportOf(result)?.matches,
        jsLines("😀\naba\nab\n", [pattern], false, false).length,
      );
    });
  }
});

test("zero-width assertions at LF and CRLF boundaries → match only empty physical lines", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-zero-width-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.txt");
  await writeFile(path, "a\nb\r\nc\n\nd\r\n\r\nx y\n");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const [pattern, multiline] of [
    ["^$", false],
    ["^ *$", false],
    ["(?<![a-z])$", false],
    ["^(?![a-z])", false],
    ["(?<!\\w)(?!\\w)", false],
    ["\\B", false],
    ["\\B", true],
  ] as const) {
    await t.test(`${pattern} multiline=${multiline}`, async () => {
      const result = await callTool(tool, {
        path,
        pattern,
        literal: false,
        ignoreCase: false,
        multiline,
      });
      assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
      const body = result.content[0];
      assert.ok(body.type === "text");
      const lines = [...body.text.matchAll(/^(\d+)#[0-9A-Z]+│/gm)].map((match) => Number(match[1]));
      assert.deepEqual(lines, [4, 6]);
      assert.equal(reportOf(result)?.matches, 2);
    });
  }
});

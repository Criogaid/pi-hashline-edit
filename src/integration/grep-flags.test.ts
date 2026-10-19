import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { grepCounts } from "../pi/grep-output.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { rejectsArgument } from "../pi/argument-error.testing.ts";

const cases = [
  {
    name: "u counts Unicode code points",
    pattern: "^.$",
    flags: "mu",
    source: "😀\na\nab\n",
    lines: [1, 2],
  },
  {
    name: "v counts Unicode code points",
    pattern: "^.$",
    flags: "mv",
    source: "😀\na\nab\n",
    lines: [1, 2],
  },
  {
    name: "Unicode property escape",
    pattern: "^\\p{Letter}+$",
    flags: "mu",
    source: "é\nabc\n12\n",
    lines: [1, 2],
  },
  {
    name: "Unicode set intersection",
    pattern: "^[\\p{ASCII}&&\\p{Letter}]+$",
    flags: "mv",
    source: "é\nabc\n12\n",
    lines: [2],
  },
  {
    name: "Unicode set subtraction",
    pattern: "^[\\p{Letter}--[a-z]]+$",
    flags: "mv",
    source: "é\nabc\nΩ\n",
    lines: [1, 3],
  },
  {
    name: "Unicode string set",
    pattern: "^[\\q{ab|cd}]$",
    flags: "mv",
    source: "ab\ncd\na\n",
    lines: [1, 2],
  },
  {
    name: "Unicode property of strings",
    pattern: "^\\p{RGI_Emoji}$",
    flags: "mv",
    source: "👨‍👩‍👧‍👦\n😀\nx\n",
    lines: [1, 2],
  },
  {
    name: "Unicode case folding includes Kelvin",
    pattern: "^k$",
    flags: "miu",
    source: "k\nK\nK\n",
    lines: [1, 2, 3],
  },
  {
    name: "non-Unicode case folding excludes Kelvin",
    pattern: "^k$",
    flags: "mi",
    source: "k\nK\nK\n",
    lines: [1, 2],
  },
  {
    name: "Unicode caseless word set",
    pattern: "^\\w$",
    flags: "miu",
    source: "ſ\nK\nk\né\n",
    lines: [1, 2, 3],
  },
  {
    name: "dotAll crosses physical lines when enabled",
    pattern: "^a.b$",
    flags: "s",
    source: "a\nb",
    multiline: true,
    lines: [1, 2],
  },
  {
    name: "dotAll does not override line mode",
    pattern: "^a.b$",
    flags: "s",
    source: "a\nb",
    lines: [],
  },
  {
    name: "explicit flags can disable m",
    pattern: "^a$",
    flags: "",
    source: "x\na",
    multiline: true,
    lines: [],
  },
  {
    name: "explicit m restores line anchors",
    pattern: "^a$",
    flags: "m",
    source: "x\na",
    multiline: true,
    lines: [2],
  },
  {
    name: "sticky matching starts at each physical line",
    pattern: "a",
    flags: "y",
    source: "ba\na\n",
    lines: [2],
  },
  {
    name: "sticky whole-file matching stops at first failure",
    pattern: "a",
    flags: "y",
    source: "ba\na\n",
    multiline: true,
    lines: [],
  },
  {
    name: "global sticky matches remain contiguous",
    pattern: "a",
    flags: "gy",
    source: "aa\nba\n",
    multiline: true,
    lines: [1],
  },
  {
    name: "global and indices flags reset between physical lines",
    pattern: "a",
    flags: "gd",
    source: "a\na",
    lines: [1, 2],
  },
  {
    name: "Unicode zero-width advancement",
    pattern: "(?=.)",
    flags: "u",
    source: "😀\nx",
    multiline: true,
    lines: [1, 2],
  },
  {
    name: "Unicode mode cannot split a surrogate pair",
    pattern: "\\uDE00",
    flags: "u",
    source: "😀x",
    lines: [],
  },
  ...["s", "m"].flatMap((flags) => [
    {
      name: `lowercase pattern with ${flags} → smart-case ignores case`,
      pattern: "^foo$",
      flags,
      source: "FOO\nfoo\n",
      lines: [1, 2],
    },
    {
      name: `uppercase pattern with ${flags} → smart-case is case-sensitive`,
      pattern: "^FOO$",
      flags,
      source: "FOO\nfoo\n",
      lines: [1],
    },
  ]),
  {
    name: "explicit i overrides uppercase smart-case",
    pattern: "^FOO$",
    flags: "i",
    source: "FOO\nfoo\n",
    lines: [1, 2],
  },
  {
    name: "ignoreCase false overrides i",
    pattern: "^foo$",
    flags: "mi",
    ignoreCase: false,
    source: "FOO\nfoo\n",
    lines: [2],
  },
  {
    name: "ignoreCase true enables i",
    pattern: "^FOO$",
    flags: "m",
    ignoreCase: true,
    source: "FOO\nfoo\n",
    lines: [1, 2],
  },
  {
    name: "literal Unicode case folding",
    pattern: "k",
    literal: true,
    flags: "iu",
    source: "k\nK\nK\n",
    lines: [1, 2, 3],
  },
  {
    name: "flag lists deduplicate",
    pattern: "^foo$",
    flags: "mmi",
    source: "FOO\nfoo\n",
    lines: [1, 2],
  },
];

test("grep flags: JavaScript modes preserve native matching through the real search pipeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-flags-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await writeFile(path, scenario.source);
      const result = await callTool(tool, {
        path,
        pattern: scenario.pattern,
        literal: scenario.literal ?? false,
        flags: scenario.flags,
        multiline: scenario.multiline ?? false,
        ...(scenario.ignoreCase === undefined ? {} : { ignoreCase: scenario.ignoreCase }),
      });
      assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
      assert.equal(grepCounts(result).matches, scenario.lines.length);
      const body = result.content[0];
      assert.ok(body.type === "text");
      const lines = [...body.text.matchAll(/^(\d+)#[0-9A-Z]+│/gm)].map((match) => Number(match[1]));
      assert.deepEqual(lines, scenario.lines);
    });
  }
});

test("grep flags: invalid Unicode syntax rejects the pattern argument", async () => {
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, {});
  await assert.rejects(
    callTool(tool, {
      path: "missing.txt",
      pattern: "\\p{NotAProperty}",
      literal: false,
      flags: "u",
    }),
    rejectsArgument("pattern"),
  );
});

test("grep flags: valid V8 patterns exceeding translator parser depth still execute", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-parser-depth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, "A\na\n");
  const pattern = `${"(?:".repeat(3_000)}A${")".repeat(3_000)}`;
  assert.equal(new RegExp(pattern).test("A"), true);
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const flags of [undefined, "m"]) {
    const result = await callTool(tool, {
      path,
      pattern,
      literal: false,
      ...(flags === undefined ? {} : { flags }),
    });
    assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
    assert.equal(grepCounts(result).matches, 1);
  }
});

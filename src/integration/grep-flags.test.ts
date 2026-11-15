import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { DEFAULT_CONFIG, makeGrepOverride } = await import("../pi/tool-factories.testing.ts");

import { reportOf } from "../pi/report.ts";
const { grepCounts } = await import("../pi/grep-output.testing.ts");
import { callTool } from "../pi/tool-call.testing.ts";

const cases = [
  {
    name: "lowercase pattern → smart-case ignores case",
    pattern: "^foo$",
    source: "FOO\nfoo\n",
    lines: [1, 2],
  },
  {
    name: "uppercase pattern → smart-case is case-sensitive",
    pattern: "^FOO$",
    source: "FOO\nfoo\n",
    lines: [1],
  },
  {
    name: "ignoreCase false with lowercase pattern → matches case-sensitively",
    pattern: "^foo$",
    ignoreCase: false,
    source: "FOO\nfoo\n",
    lines: [2],
  },
  {
    name: "ignoreCase true with uppercase pattern → matches case-insensitively",
    pattern: "^FOO$",
    ignoreCase: true,
    source: "FOO\nfoo\n",
    lines: [1, 2],
  },
];

test("grep case options → preserve native matching through the real search pipeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-flags-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  const tool = makeGrepOverride(directory, DEFAULT_CONFIG);
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await writeFile(path, scenario.source);
      const result = await callTool(tool, {
        path,
        pattern: scenario.pattern,
        literal: false,
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

test("valid V8 patterns exceeding translator parser depth → still execute", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-parser-depth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, "A\na\n");
  const pattern = `${"(?:".repeat(3_000)}A${")".repeat(3_000)}`;
  assert.equal(new RegExp(pattern).test("A"), true);
  const tool = makeGrepOverride(directory, DEFAULT_CONFIG);
  const result = await callTool(tool, { path, pattern, literal: false });
  assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
  assert.equal(grepCounts(result).matches, 1);
});

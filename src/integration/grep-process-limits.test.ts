import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/tool-factories.testing.ts";
import { grepCounts } from "../pi/grep-output.testing.ts";
import { makeGrepOverride } from "../pi/tool-factories.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { reportOf } from "../pi/report.ts";
import { callTool } from "../pi/tool-call.testing.ts";

for (const input of ["explicit paths", "globs"] as const) {
  test(`2000 ${input} exceed the Windows command line → report RIPGREP_FAILED with ENAMETOOLONG`, {
    skip: process.platform !== "win32" ? "Requires the Windows command-line length limit" : false,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hl-rg-launch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "needle.txt");
    await writeFile(file, "needle\n");
    const args =
      input === "explicit paths"
        ? { path: Array.from({ length: 2000 }, () => file) }
        : {
            path: [file],
            glob: Array.from({ length: 2000 }, (_, index) => `**/needle-${index}-*.txt`),
          };
    await expectToolFailure(
      callTool(makeGrepOverride(directory, DEFAULT_CONFIG), {
        ...args,
        pattern: ["needle"],
        literal: true,
      }),
      "RIPGREP_FAILED",
      (report) => assert.equal(report.cause?.code, "ENAMETOOLONG"),
    );
  });
}

test("multiline prefilter exceeds the rg pattern budget → scan all files and retain native matches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-rg-prefilter-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const starts = [0x100, 0x140, 0x180, 0x1c0];
  for (const start of starts)
    await writeFile(join(directory, `${start}.txt`), String.fromCodePoint(start).repeat(64));
  await writeFile(join(directory, "literal.txt"), "needle\n");
  const tool = makeGrepOverride(directory, DEFAULT_CONFIG);
  for (const count of [2, 3, 4]) {
    await t.test(
      `${count} large character classes → full scan finds every matching file`,
      async () => {
        const result = await callTool(tool, {
          path: [directory],
          pattern: starts
            .slice(0, count)
            .map(
              (start) => `[${String.fromCodePoint(start)}-${String.fromCodePoint(start + 63)}]{64}`,
            ),
          literal: false,
          multiline: true,
          ignoreCase: false,
        });
        assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
        assert.deepEqual(grepCounts(result), { matches: count, files: count });
        assert.equal(reportOf(result, "grep")?.scanned, "all");
      },
    );
  }
  const literal = await callTool(tool, {
    path: [directory],
    pattern: ["needle"],
    literal: true,
    multiline: true,
  });
  assert.equal(literal.isError, undefined);
  assert.deepEqual(grepCounts(literal), { matches: 1, files: 1 });
  assert.equal(reportOf(literal, "grep")?.scanned, "files");
});

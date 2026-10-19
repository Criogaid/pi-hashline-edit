import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatByteSize } from "../pi/budgets.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { MAX_MULTILINE_SEARCH_BYTES } from "../pi/grep-search.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "../pi/grep-candidates.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { OUTCOME_NEXT } from "../pi/report-schema.ts";
import { reportOf } from "../pi/report.ts";
import { grepCounts } from "../pi/grep-output.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";

test("all-file candidates exceed the scan budget → stop listing and retain scan facts with or without matches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-scan-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scanLimitNext = OUTCOME_NEXT.find(([fact]) => fact === "scanLimit")?.[1];
  assert.ok(scanLimitNext);
  const padding: string[] = [];
  // NUL files consume real scan bytes without building large regex inputs or exceeding the per-file cap.
  for (let remaining = MAX_UNNARROWED_SCAN_BYTES; remaining > 0; ) {
    const size = Math.min(remaining, MAX_MULTILINE_SEARCH_BYTES);
    const path = join(directory, `padding-${padding.length}.bin`);
    await writeFile(path, "");
    await truncate(path, size);
    padding.push(path);
    remaining -= size;
  }
  const fixture = join(directory, "fixture.txt");
  const blocked = join(directory, "beyond-budget.txt");
  const unlisted = join(directory, "unlisted.txt");
  await writeFile(blocked, "abc\n");
  await writeFile(unlisted, "abc\n");
  const paths = [fixture, ...padding, blocked, unlisted];
  for (const scenario of [
    { name: "matches", source: "abc\n", matches: 1, stderr: "" },
    { name: "zero matches", source: "xxx\n", matches: 0, stderr: "" },
    {
      name: "zero matches with listing diagnostics",
      source: "xxx\n",
      matches: 0,
      stderr: "listing interrupted",
    },
  ]) {
    await t.test(scenario.name, async () => {
      await writeFile(fixture, scenario.source);
      const offered: string[] = [];
      let stopped = false;
      const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
        runRgLines: async () => assert.fail("multiline candidates must use file listing"),
        runRgPaths: async (_rgPath, _args, _signal, onFile) => {
          for (const path of paths) {
            offered.push(path);
            if (!(await onFile(path))) {
              stopped = true;
              break;
            }
          }
          return { code: scenario.stderr ? 2 : 0, stderr: scenario.stderr, stopped };
        },
      });
      const result = await callTool(tool, {
        path: directory,
        pattern: "[^x\\s]{3}\\s",
        literal: false,
        multiline: true,
      });
      assert.equal(stopped, true);
      assert.deepEqual(offered, [fixture, ...padding, blocked]);
      const report = reportOf(result, "grep");
      assert.ok(report);
      assert.equal(report.candidates, "all");
      assert.equal(report.scanLimit, formatByteSize(MAX_UNNARROWED_SCAN_BYTES));
      if (scenario.stderr) {
        assert.equal(result.isError, true);
        assert.equal(report.error, "SEARCH_INCOMPLETE");
        assert.match(report.diagnostics ?? "", /listing interrupted/);
      } else {
        assert.equal(result.isError, undefined);
        assert.equal(grepCounts(result).matches, scenario.matches);
        assert.equal(report.diagnostics, undefined);
        assert.equal(report.next, scanLimitNext);
        if (scenario.matches) assert.match(result.content[0].text, /fixture\.txt/);
      }
    });
  }
});

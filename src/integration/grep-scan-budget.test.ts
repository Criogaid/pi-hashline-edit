import assert from "node:assert/strict";
import fs, { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { formatByteSize } from "../pi/budgets.ts";
import { OUTCOME_NEXT } from "../pi/report-schema.ts";
import { reportOf } from "../pi/report.ts";
import { callTool } from "../pi/tool-call.testing.ts";

// The scan-order fixture holds one worker while listing a second candidate, even on single-core hosts.
const parallelism = mock.method(os, "availableParallelism", () => 3);
syncBuiltinESMExports();
const { makeMockGrep } = await import("../pi/grep-rg.testing.ts").finally(() => {
  parallelism.mock.restore();
  syncBuiltinESMExports();
});
const { DEFAULT_CONFIG, makeGrepOverride } = await import("../pi/tool-factories.testing.ts");
const { MAX_UNNARROWED_SCAN_BYTES } = await import("../pi/grep-candidates.ts");
const { grepCounts } = await import("../pi/grep-output.testing.ts");
const MAX_MULTILINE_SEARCH_BYTES = 64 * 1024 * 1024;

test("repeated all-file candidates → count each file once toward the scan budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-repeated-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const padding = join(directory, "a.bin");
  const fixture = join(directory, "b.txt");
  await writeFile(padding, "");
  await truncate(padding, MAX_MULTILINE_SEARCH_BYTES);
  await writeFile(fixture, "ab\n");
  const repeats = Math.ceil(MAX_UNNARROWED_SCAN_BYTES / MAX_MULTILINE_SEARCH_BYTES);
  const result = await callTool(makeGrepOverride(directory, DEFAULT_CONFIG), {
    path: [...Array<string>(repeats).fill(padding), fixture],
    pattern: ".",
    literal: false,
    multiline: true,
    outputMode: "files",
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content[0], { type: "text", text: "b.txt" });
  assert.equal(reportOf(result, "grep")?.scanLimit, undefined);
});

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
      const tool = makeMockGrep(directory, DEFAULT_CONFIG, {
        runRgLines: async () => assert.fail("multiline candidates must use file listing"),
        runRgPaths: async (_args, _cwd, _signal, onFile) => {
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
        assert.equal(result.content[0].type, "text");
        if (scenario.matches) assert.match(result.content[0].text, /fixture\.txt/);
      }
    });
  }
});

test("scan budget stops listing before the match limit → report only the match limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-match-before-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "a.txt");
  const padding = join(directory, "b.bin");
  const blocked = join(directory, "c.txt");
  await writeFile(first, "hit\n");
  await writeFile(padding, "");
  await truncate(padding, MAX_UNNARROWED_SCAN_BYTES);
  await writeFile(blocked, "hit\n");

  // Keep the first match from committing until the listing has checked the scan budget.
  const listingDone = Promise.withResolvers<void>();
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === first) await listingDone.promise;
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  const offered: string[] = [];
  const tool = makeMockGrep(directory, DEFAULT_CONFIG, {
    runRgPaths: async (_args, _cwd, _signal, onFile) => {
      try {
        for (const path of [first, padding, blocked]) {
          offered.push(path);
          if (!(await onFile(path))) return { code: 0, stderr: "", stopped: true };
        }
        return { code: 0, stderr: "", stopped: false };
      } finally {
        listingDone.resolve();
      }
    },
  });
  const result = await callTool(tool, {
    path: ["."],
    pattern: ["."],
    literal: false,
    multiline: true,
    limit: 1,
    outputMode: "files",
  });
  const report = reportOf(result, "grep");
  assert.equal(result.isError, undefined, JSON.stringify(report));
  assert.deepEqual(offered, [first, padding, blocked]);
  assert.deepEqual(result.content[0], { type: "text", text: "a.txt" });
  assert.equal(report?.matchLimit, 1);
  assert.equal(report.scanLimit, undefined);
});

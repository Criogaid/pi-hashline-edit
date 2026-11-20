/** Run with node bench/range-diff.bench.ts <baseline worktree>. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { applyReplacements } from "../src/core/replace.ts";
import type { Replacement } from "../src/core/replace-schema.ts";
import { generateMutationDetails } from "../src/pi/mutation-result.ts";
import { DEFAULT_CONFIG, makeReplaceTool } from "../src/pi/tool-factories.testing.ts";
import { callTool } from "../src/pi/tool-call.testing.ts";

const SAMPLES = 5;
const BASELINE_DENSE_LINES = 1_200;
const LARGE_FILE_LINES = 25_000;
const baseline = process.argv[2];
if (!baseline) throw new Error("Pass the baseline worktree path");
const loadBaseline = (file: string) =>
  import(pathToFileURL(resolve(baseline, "src/pi", file)).href);
const [{ generateMutationDetails: legacyDetails }, legacyFactory, legacyCaller]: [
  { generateMutationDetails(before: string, after: string): { diff: string } },
  Pick<typeof import("../src/pi/tool-factories.testing.ts"), "makeReplaceTool" | "DEFAULT_CONFIG">,
  Pick<typeof import("../src/pi/tool-call.testing.ts"), "callTool">,
] = await Promise.all([
  loadBaseline("mutation-result.ts"),
  loadBaseline("tool-factories.testing.ts"),
  loadBaseline("tool-call.testing.ts"),
]);

const worktree = await mkdtemp(join(tmpdir(), "hashline-range-diff-bench-"));
const fixture = join(worktree, "example.ts");
const tool = makeReplaceTool(worktree, DEFAULT_CONFIG);
const legacyTool = legacyFactory.makeReplaceTool(worktree, legacyFactory.DEFAULT_CONFIG);
const rules: Replacement[] = [{ literal: true, find: "'old'", replace: "'new'" }];

function measure(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function median(samples: number[]) {
  return samples.length
    ? +samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(2)
    : undefined;
}

async function callAndCheck(
  invoke: () => ReturnType<typeof tool.execute>,
  before: string,
  expected: string,
  count: number,
) {
  await writeFile(fixture, before);
  const start = performance.now();
  const result = await invoke();
  const ms = performance.now() - start;
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(fixture, "utf8"), expected);
  assert.deepEqual(result.structuredContent, { publication: "PUBLISHED", matches: count });
  const diff = "diff" in (result.details ?? {}) ? Reflect.get(result.details!, "diff") : undefined;
  assert.equal(typeof diff, "string");
  assert.equal(diff.match(/^\+/gm)?.length, count);
  assert.equal(diff.match(/^-/gm)?.length, count);
  return ms;
}

try {
  for (const { name, lineCount, sparse, runBaseline } of [
    { name: "dense", lineCount: BASELINE_DENSE_LINES, sparse: false, runBaseline: true },
    { name: "sparse", lineCount: LARGE_FILE_LINES, sparse: true, runBaseline: true },
    { name: "dense", lineCount: LARGE_FILE_LINES, sparse: false, runBaseline: false },
  ]) {
    const stride = LARGE_FILE_LINES / 5;
    const before = Array.from(
      { length: lineCount },
      (_, i) => `export const item_${i} = '${!sparse || i % stride === 17 ? "old" : "keep"}';\n`,
    ).join("");
    const { text: after, copied, count } = applyReplacements(before, rules);
    const times: Record<string, number[]> = {
      baselineDiffMs: [],
      rangeDiffMs: [],
      baselineCallMs: [],
      rangeCallMs: [],
    };
    const planned = {
      diff: () => generateMutationDetails(before, after, copied),
      call: () => callTool(tool, { path: fixture, replacements: rules }),
    };
    const legacy = {
      diff: () => legacyDetails(before, after),
      call: () => legacyCaller.callTool(legacyTool, { path: fixture, replacements: rules }),
    };
    if (runBaseline) await callAndCheck(legacy.call, before, after, count);
    await callAndCheck(planned.call, before, after, count);
    for (let i = 0; i < SAMPLES; i++) {
      for (const variant of i % 2 ? ["range", "baseline"] : ["baseline", "range"]) {
        if (!runBaseline && variant === "baseline") continue;
        const step = variant === "baseline" ? legacy : planned;
        times[`${variant}DiffMs`].push(measure(step.diff));
        times[`${variant}CallMs`].push(await callAndCheck(step.call, before, after, count));
      }
    }
    console.log(
      JSON.stringify({
        name,
        lineCount,
        matches: count,
        samples: SAMPLES,
        ...Object.fromEntries(
          Object.entries(times).map(([field, values]) => [field, median(values)]),
        ),
      }),
    );
  }
} finally {
  await rm(worktree, { recursive: true, force: true });
}

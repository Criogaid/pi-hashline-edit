/** Run with node bench/range-diff.bench.ts ../range-diff-provenance. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { computeLineHash } from "../src/core/hash.ts";
import { applyReplacements } from "../src/core/replace.ts";
import type { Replacement } from "../src/core/replace-schema.ts";
import { generateMutationDetails } from "../src/pi/mutation-result.ts";
import type { diffCardRenderers } from "../src/pi/render.ts";
import { callTool } from "../src/pi/tool-call.testing.ts";
import {
  DEFAULT_CONFIG,
  makeEditOverride,
  makeReplaceTool,
} from "../src/pi/tool-factories.testing.ts";

const SAMPLES = 15;
const WARMUPS = 4;
const LARGE_FILE_LINES = 25_000;
const SPARSE_EDITS = 5;
const baseline = process.argv[2];
if (!baseline) throw new Error("Pass the range-diff provenance baseline worktree path");
const loadBaseline = (file: string) =>
  import(pathToFileURL(resolve(baseline, "src/pi", file)).href);
const [{ generateMutationDetails: baselineDetails }, baselineFactory, baselineCaller]: [
  Pick<typeof import("../src/pi/mutation-result.ts"), "generateMutationDetails">,
  typeof import("../src/pi/tool-factories.testing.ts"),
  Pick<typeof import("../src/pi/tool-call.testing.ts"), "callTool">,
] = await Promise.all([
  loadBaseline("mutation-result.ts"),
  loadBaseline("tool-factories.testing.ts"),
  loadBaseline("tool-call.testing.ts"),
]);

initTheme();
const theme = { fg: (_kind: string, s: string) => s, bold: (s: string) => s } as Theme;
const cwd = await mkdtemp(join(tmpdir(), "hashline-range-diff-bench-"));
const path = "duplicate.txt";
const fixture = join(cwd, path);
const variants = [
  {
    name: "baseline",
    hashLen: baselineFactory.DEFAULT_CONFIG.hashLen,
    details: baselineDetails,
    call: baselineCaller.callTool,
    edit: baselineFactory.makeEditOverride(cwd, baselineFactory.DEFAULT_CONFIG),
    replace: baselineFactory.makeReplaceTool(cwd, baselineFactory.DEFAULT_CONFIG),
  },
  {
    name: "candidate",
    hashLen: DEFAULT_CONFIG.hashLen,
    details: generateMutationDetails,
    call: callTool,
    edit: makeEditOverride(cwd, DEFAULT_CONFIG),
    replace: makeReplaceTool(cwd, DEFAULT_CONFIG),
  },
] as const;

type Variant = (typeof variants)[number];

async function showCard<TArgs>(
  variant: Variant,
  tool: Omit<Variant["edit"] | Variant["replace"], "renderCall" | "renderResult"> &
    ReturnType<typeof diffCardRenderers<TArgs>>,
  args: TArgs,
  line: number,
) {
  await writeFile(fixture, "same\nsame");
  const result = await variant.call(tool, args);
  assert.equal(result.isError, undefined);
  assert.deepEqual(await readFile(fixture), Buffer.from("same"));
  const state = {};
  const context = {
    cwd,
    args,
    state,
    isError: false,
    keyHint: (_key: string, text: string) => text,
  };
  const heading = tool.renderCall(args, theme, context);
  const body = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context);
  const rows = [...heading.render(120), ...body.render(120)].map((row) =>
    stripVTControlCharacters(row).trimEnd(),
  );
  const displayedLine = variant.name === "baseline" ? 1 : line;
  assert.deepEqual(
    rows.filter((row) => /^[ +\-]\d+ /.test(row)),
    displayedLine === 1 ? ["-1 same", " 2 same"] : [" 1 same", "-2 same"],
  );
  console.log(JSON.stringify({ variant: variant.name, tool: tool.name, line, card: rows }));
}

function median(samples: number[]) {
  return +samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(2);
}

async function compare(name: string, lineCount: number, sparse: boolean, wide = false) {
  const stride = lineCount / SPARSE_EDITS;
  const before = Array.from(
    { length: lineCount },
    (_, i) => `export const item_${i} = '${!sparse || i % stride === 17 ? "old" : "keep"}';\n`,
  ).join("");
  const rules: Replacement[] = wide
    ? [{ literal: true, find: before, replace: before.replaceAll("'old'", "'new'") }]
    : [{ literal: true, find: "'old'", replace: "'new'" }];
  const { text: after, copied, count } = applyReplacements(before, rules);
  const diff = baselineDetails(before, after, copied).diff;
  const changedRows = sparse ? SPARSE_EDITS : lineCount;
  assert.equal(diff.match(/^\+/gm)?.length, changedRows);
  assert.equal(diff.match(/^-/gm)?.length, changedRows);
  const times: Record<Variant["name"], { diff: number[]; call: number[] }> = {
    baseline: { diff: [], call: [] },
    candidate: { diff: [], call: [] },
  };
  for (let i = 0; i < WARMUPS + SAMPLES; i++) {
    for (const variant of i % 2 ? [...variants].reverse() : variants) {
      const startDiff = performance.now();
      const details = variant.details(before, after, copied);
      const diffMs = performance.now() - startDiff;
      assert.equal(details.diff, diff);

      await writeFile(fixture, before);
      const startCall = performance.now();
      const result = await variant.call(variant.replace, { path, replacements: rules });
      const callMs = performance.now() - startCall;
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { publication: "PUBLISHED", matches: count });
      assert.ok(result.details && "diff" in result.details);
      assert.equal(result.details.diff, diff);
      assert.deepEqual(await readFile(fixture), Buffer.from(after));
      if (i >= WARMUPS) {
        times[variant.name].diff.push(diffMs);
        times[variant.name].call.push(callMs);
      }
    }
  }
  console.log(
    JSON.stringify({
      name,
      lineCount,
      bytes: Buffer.byteLength(before),
      matches: count,
      changedRows,
      warmups: WARMUPS,
      samples: SAMPLES,
      baselineDiffMs: median(times.baseline.diff),
      candidateDiffMs: median(times.candidate.diff),
      baselineCallMs: median(times.baseline.call),
      candidateCallMs: median(times.candidate.call),
    }),
  );
}

try {
  for (const line of [1, 2]) {
    for (const variant of variants) {
      await showCard(
        variant,
        variant.edit,
        {
          path,
          steps: [
            {
              action: "delete" as const,
              anchor: `${line}#${computeLineHash(line, "same", variant.hashLen)}`,
            },
          ],
        },
        line,
      );
      await showCard(
        variant,
        variant.replace,
        {
          path,
          replacements: [{ literal: true, find: line === 1 ? "same\n" : "\nsame", replace: "" }],
        },
        line,
      );
    }
  }
  await compare("dense", 1_200, false);
  await compare("sparse", LARGE_FILE_LINES, true);
  await compare("sparse-wide", LARGE_FILE_LINES, true, true);
  await compare("dense", LARGE_FILE_LINES, false);
} finally {
  await rm(cwd, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { extractPrefilter, type Prefilter } from "../core/search-analysis.ts";
import {
  acceptsNative,
  MATRIX_FLAGS,
  MATRIX_INPUTS,
  MATRIX_SYNTAX,
} from "../core/search-matrix.testing.ts";
import { searchText, type GrepQuery } from "../core/search.ts";
import { assertRgSucceeded, runRgPaths } from "../pi/rg-process.ts";
import { runCandidatePaths } from "../pi/grep-candidates.ts";

const syntaxCases = [
  ...MATRIX_SYNTAX,
  ["optional literal", "colou?r"],
  ["empty alternative", "(?:needle|)"],
  ["literal around wildcard", "needle.*tail"],
  ["literal lookahead only", "(?=needle)"],
  ["literal lookbehind only", "(?<=needle)"],
  ["consuming after lookbehind", "(?<=needle)tail"],
  ["literal capture reference", "(needle)\\1"],
  ["lookahead capture reference", "(?=(needle))\\1"],
  ["mixed case modifiers", "(?i:n)(?-i:eedle)"],
  ["zero LF capture", "(a\\n{0})\\1"],
  ["optional LF capture", "(a\\n{0,1})\\1"],
  ["zero Unicode capture", "(aé{0})\\1"],
  ["zero reference capture", "(a(?:\\1){0})\\1"],
  ["separated surrogate halves", "\\uD83D(?:)\\uDE00"],
  ["surrogate classes", "[\\uD83D][\\uDE00]"],
  ["wide class", "[\\u0001-\\u0100]"],
  ["many alternatives", Array.from({ length: 65 }, (_, i) => `token${i}`).join("|")],
  ["long repetition", "a{65}"],
  ["zero repetition", "x{0}"],
  ["nested v subtraction", "[[a-z]--[aeiou]]"],
  ["v empty string alternative", "[\\q{|ab}]"],
] as const;

interface Coverage {
  queries: number;
  fullScan: number;
  withHits: number;
  nativeFiles: number;
  candidateFiles: number;
}

function emptyCoverage(): Coverage {
  return { queries: 0, fullScan: 0, withHits: 0, nativeFiles: 0, candidateFiles: 0 };
}

interface CandidateCase {
  readonly prefilter: Prefilter;
  readonly required: Map<string, GrepQuery>;
  readonly contributions: Map<Coverage, number>;
}

test("Cartesian prefilter coverage × composition × flags × bytes → real rg retains witnessed JS hits and reports selectivity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-prefilter-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const witnesses = [
    "needle\nneedletail\nneedleXYZtail\nneedleneedle\nNeedle\nNEEDLE\ncolor\ncolour\n",
    `${"a".repeat(65)}\ntoken0\ntoken64\n`,
    "ab\ncd\nα\nβ\n漢\n𐐀\n𐐨\n👩‍💻\n🇺🇳\n",
    "kſ\nKs\nσςΣ\néÉ\n\\K\nK\n",
    "a\nb\r\na\r\nb\na\na\n",
  ];
  const sources = [
    ...MATRIX_INPUTS.map(([, bytes]) => bytes),
    ...witnesses.map((source) => Buffer.from(source)),
    ...[...MATRIX_INPUTS.map(([, bytes]) => bytes.toString("utf8")), ...witnesses].map((source) =>
      Buffer.from(source.replace(/$/gm, "needle")),
    ),
    // Separate nonmatching files make selectivity observable without timing assertions.
    ...Array.from({ length: 64 }, (_, i) =>
      Buffer.from(`export const record_${i} = { id: ${i}, enabled: true };\n`),
    ),
  ];
  const inputs = sources.map((bytes, index) => ({
    name: `${index}.txt`,
    source: bytes.toString("utf8"),
    bytes,
  }));
  for (const input of inputs) await writeFile(join(directory, input.name), input.bytes);
  const compositions = new Map<string, Coverage>();
  const syntax = new Map<string, Coverage>();
  const groups = new Map<string, CandidateCase>();
  let rejected = 0;
  for (const [label, pattern] of syntaxCases) {
    const row = emptyCoverage();
    syntax.set(label, row);
    for (const [composition, patterns] of [
      ["bare", [pattern]],
      ["required literal", [`(?:${pattern})needle`]],
      ["OR-array", [pattern, "needle"]],
    ] as const) {
      const total = compositions.get(composition) ?? emptyCoverage();
      compositions.set(composition, total);
      for (const flags of MATRIX_FLAGS) {
        for (const multiline of [false, true]) {
          const query: GrepQuery = { patterns: [...patterns], flags, multiline, literal: false };
          if (!acceptsNative(query)) {
            rejected++;
            continue;
          }
          const prefilter = extractPrefilter(query);
          const key = JSON.stringify(prefilter);
          let group = groups.get(key);
          if (!group) {
            group = { prefilter, required: new Map(), contributions: new Map() };
            groups.set(key, group);
          }
          let hits = 0;
          for (const input of inputs) {
            if (!searchText({ source: input.source, query, limit: 1 }).lines.length) continue;
            hits++;
            if (!group.required.has(input.name)) group.required.set(input.name, query);
          }
          for (const stats of composition === "bare" ? [total, row] : [total]) {
            stats.queries++;
            stats.fullScan += Number(prefilter.kind === "all");
            stats.withHits += Number(hits > 0);
            stats.nativeFiles += hits;
            group.contributions.set(stats, (group.contributions.get(stats) ?? 0) + 1);
          }
        }
      }
    }
  }
  const cases = [...groups.values()];
  let next = 0;
  let checkedFiles = 0;
  const processTimeoutMs = 10_000;
  const concurrency = 4;
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < cases.length) {
        const group = cases[next++];
        const actual = new Set<string>();
        const result = await runCandidatePaths(
          runRgPaths,
          rgPath,
          group.prefilter,
          ["--null", "--", directory],
          AbortSignal.timeout(processTimeoutMs),
          (path) => {
            actual.add(basename(path));
            return true;
          },
        );
        assertRgSucceeded(result);
        for (const [name, query] of group.required) {
          checkedFiles++;
          assert.ok(actual.has(name), JSON.stringify({ name, query, prefilter: group.prefilter }));
        }
        for (const [stats, count] of group.contributions)
          stats.candidateFiles += actual.size * count;
      }
    }),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  const unwitnessed = [...syntax]
    .filter(([, stats]) => stats.withHits === 0)
    .map(([label]) => label);
  t.diagnostic(
    JSON.stringify({
      files: inputs.length,
      syntaxCases: syntaxCases.length,
      rejected,
      candidateExpressions: cases.length,
      checkedFiles,
      unwitnessed,
    }),
  );
  for (const [composition, stats] of compositions)
    t.diagnostic(
      JSON.stringify({ composition, ...stats, possibleFiles: stats.queries * inputs.length }),
    );
  for (const [label, stats] of syntax) t.diagnostic(JSON.stringify({ syntax: label, ...stats }));
  // A NUL-only pattern cannot match grep's searchable (non-NUL) file domain.
  assert.deepEqual(unwitnessed, ["NUL"]);
  const requiredLiteral = compositions.get("required literal");
  assert.ok(requiredLiteral);
  assert.ok(requiredLiteral.candidateFiles < requiredLiteral.queries * inputs.length);
  assert.ok(checkedFiles > 0);
});

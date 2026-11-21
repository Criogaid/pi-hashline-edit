/**
 * Grep candidate tiers against whole-scope V8 scanning and a PCRE2 ceiling.
 *
 *   node bench/grep-tiers.bench.ts <corpus-dir>... [--reps N]
 *
 * Each sample is a fresh Node process that runs searchFiles once to warm up and once timed.
 * Variants replace modules with node:test module mocks, so business code is unchanged:
 * - tiers: the shipped rg-regex line translation, then the literal prefilter, then every file.
 * - v8: no narrowing; rg lists every file in scope and V8 checks each one.
 * - pcre2: rg's PCRE2 engine runs the JavaScript source directly as the line listing. This is
 *   a ceiling, not a candidate implementation: it can lose JavaScript matches, and the
 *   report counts every result that differs from tiers.
 * Node CPU covers the main thread and the regex workers; rg's own CPU is outside it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const VARIANTS = ["tiers", "v8", "pcre2"] as const;
type Variant = (typeof VARIANTS)[number];

interface BenchQuery {
  readonly name: string;
  readonly patterns: readonly string[];
  readonly literal?: boolean;
  readonly ignoreCase?: boolean;
}

const QUERIES: readonly BenchQuery[] = [
  { name: "absent literal", patterns: ["zqxjv_absent_token"], literal: true },
  { name: "literal TODO", patterns: ["TODO"], literal: true },
  { name: "alternation call", patterns: [String.raw`console\.(log|warn|error)\(`] },
  { name: "identifier regex", patterns: [String.raw`\bfunction\s+\w+Async\b`] },
  { name: "ignoreCase word", patterns: ["deprecated"], ignoreCase: true },
  { name: "no literal date", patterns: [String.raw`\d{4}-\d{2}-\d{2}`] },
  { name: "lookbehind", patterns: [String.raw`(?<=import\s)type\b`] },
  { name: "lookahead", patterns: [String.raw`\bnew Promise(?=\()`] },
  { name: "backreference", patterns: [String.raw`(["'])use strict\1`] },
  { name: "CJK class", patterns: [String.raw`[一-鿿]{2,}`] },
  { name: "dense blank", patterns: [String.raw`^\s*$`] },
];
const LIMITS = [100, 10_000];

interface Sample {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly maxRssMiB: number;
  readonly matches: number;
  readonly files: number;
  readonly candidateFiles: number;
  readonly candidateLines: number;
  readonly scanLimitReached: boolean;
  readonly signature: string;
}

const childIndex = process.argv.indexOf("--child");
if (childIndex !== -1) {
  const [variant, corpus, queryIndex, limit] = process.argv.slice(childIndex + 1);
  console.log(
    JSON.stringify(
      await runChild(variant as Variant, corpus, QUERIES[Number(queryIndex)], Number(limit)),
    ),
  );
} else {
  await runParent();
}

async function runChild(
  variant: Variant,
  corpus: string,
  query: BenchQuery,
  limit: number,
): Promise<Sample> {
  const { mock } = await import("node:test");
  const url = (path: string) => new URL(path, import.meta.url).href;
  const rgProcessUrl = url("../src/pi/rg-process.ts");
  const rgProcess = await import(rgProcessUrl);
  const engine = (args: string[]) =>
    variant === "pcre2"
      ? args.map((arg) => (arg === "--engine=default" ? "--engine=pcre2" : arg))
      : args;
  let candidateFiles = 0;
  let candidateLines = 0;
  mock.module(rgProcessUrl, {
    namedExports: {
      ...rgProcess,
      runRgLines: (
        args: string[],
        cwd: string,
        signal: AbortSignal,
        maxLines: number,
        onFile: Function,
      ) =>
        rgProcess.runRgLines(
          engine(args),
          cwd,
          signal,
          maxLines,
          (path: string, lines?: number[]) => {
            candidateFiles++;
            candidateLines += lines?.length ?? 0;
            return onFile(path, lines);
          },
        ),
      runRgPaths: (args: string[], cwd: string, signal: AbortSignal, onPath: Function) =>
        rgProcess.runRgPaths(args, cwd, signal, (path: string) => {
          candidateFiles++;
          return onPath(path);
        }),
      rgRejectsPatterns: (args: string[], cwd: string, signal: AbortSignal) =>
        rgProcess.rgRejectsPatterns(engine(args), cwd, signal),
    },
  });
  if (variant !== "tiers") {
    const rgRegexUrl = url("../src/pi/rg-regex.ts");
    const rgRegex = await import(rgRegexUrl);
    mock.module(rgRegexUrl, {
      namedExports: {
        ...rgRegex,
        lineCandidatePatterns: (q: typeof grepQuery) =>
          variant === "v8" ? undefined : q.patterns.map((pattern) => pcre2Pattern(pattern, q)),
      },
    });
  }
  if (variant === "v8") {
    const analysisUrl = url("../src/core/search-analysis.ts");
    const analysis = await import(analysisUrl);
    mock.module(analysisUrl, {
      namedExports: { ...analysis, extractPrefilter: () => ({ kind: "all" }) },
    });
  }

  const { searchFiles } = await import(url("../src/pi/grep-search.ts"));
  const { loadConfig } = await import(url("../src/pi/config.ts"));
  const timeoutMs: number = loadConfig(process.cwd()).grep.regexTimeoutMs;
  const grepQuery = {
    patterns: query.patterns,
    literal: query.literal ?? false,
    ignoreCase: query.ignoreCase ?? false,
    multiline: false,
  };
  const search = () =>
    searchFiles({
      scope: { cwd: process.cwd(), globs: [], searchPaths: [resolve(corpus)] },
      query: grepQuery,
      limit,
      timeoutMs,
    });

  await search();
  candidateFiles = 0;
  candidateLines = 0;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const result = await search();
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const rows = result.files.map(
    (file: { filePath: string; rows: { lineNumber: number; column: number }[] }) => [
      file.filePath,
      file.rows.map((row) => `${row.lineNumber}:${row.column}`),
    ],
  );
  return {
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
    matches: rows.reduce((sum: number, [, lines]: [string, string[]]) => sum + lines.length, 0),
    files: rows.length,
    candidateFiles,
    candidateLines,
    scanLimitReached: result.scanLimitReached,
    signature: createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16),
  };
}

/** The JavaScript source as a PCRE2 pattern, with no translation of any construct. */
function pcre2Pattern(pattern: string, query: { literal: boolean; ignoreCase: boolean }) {
  const source = query.literal ? `\\Q${pattern.replaceAll("\\E", "\\E\\\\E\\Q")}\\E` : pattern;
  return query.ignoreCase ? `(?i)${source}` : source;
}

async function runParent() {
  const args = process.argv.slice(2);
  const repsIndex = args.indexOf("--reps");
  const reps = repsIndex === -1 ? 3 : Number(args[repsIndex + 1]);
  const corpora =
    repsIndex === -1
      ? args
      : args.filter((_, index) => index !== repsIndex && index !== repsIndex + 1);
  if (corpora.length === 0) throw new Error("Pass at least one corpus directory.");
  const script = fileURLToPath(import.meta.url);
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const totals = new Map<Variant, number>(VARIANTS.map((variant) => [variant, 0]));

  console.log(`Node ${process.version}, ${reps} processes per cell, variant order rotated.\n`);
  for (const corpus of corpora) {
    console.log(`## ${resolve(corpus)}\n`);
    console.log(
      "| query | limit | wall ms tiers / v8 / pcre2 | Node CPU ms tiers / v8 / pcre2 | peak RSS MiB tiers / v8 / pcre2 | candidate files tiers / v8 / pcre2 | matches | v8 vs tiers | pcre2 vs tiers |",
    );
    console.log("| --- | ---: | --- | --- | --- | --- | ---: | --- | --- |");
    for (const [queryIndex, query] of QUERIES.entries()) {
      for (const limit of LIMITS) {
        const samples = new Map<Variant, Sample[]>(VARIANTS.map((variant) => [variant, []]));
        for (let rep = 0; rep < reps; rep++) {
          for (let offset = 0; offset < VARIANTS.length; offset++) {
            const variant = VARIANTS[(rep + offset) % VARIANTS.length];
            const output = execFileSync(
              process.execPath,
              [
                "--experimental-test-module-mocks",
                "--no-warnings",
                script,
                "--child",
                variant,
                corpus,
                String(queryIndex),
                String(limit),
              ],
              { encoding: "utf8", maxBuffer: 1 << 20 },
            );
            samples.get(variant)!.push(JSON.parse(output.trim().split("\n").at(-1)!));
          }
        }
        const cell = (pick: (sample: Sample) => number, digits = 0) =>
          VARIANTS.map((variant) => median(samples.get(variant)!.map(pick)).toFixed(digits)).join(
            " / ",
          );
        for (const variant of VARIANTS)
          totals.set(
            variant,
            totals.get(variant)! + median(samples.get(variant)!.map((sample) => sample.wallMs)),
          );
        const tiersSample = samples.get("tiers")![0];
        const agreement = (variant: Variant) => {
          const own = samples.get(variant)!;
          // A sample that stopped at the unnarrowed scan limit did not search the whole scope.
          if ([...own, tiersSample].some((sample) => sample.scanLimitReached)) return "scan limit";
          if (own.some((sample) => sample.signature !== own[0].signature)) return "unstable";
          return own[0].signature === tiersSample.signature
            ? "same"
            : `differs (${own[0].matches} matches)`;
        };
        console.log(
          `| ${query.name} | ${limit} | ${cell((s) => s.wallMs)} | ${cell((s) => s.cpuMs)} | ${cell((s) => s.maxRssMiB, 1)} | ${cell((s) => s.candidateFiles)} | ${tiersSample.matches} | ${agreement("v8")} | ${agreement("pcre2")} |`,
        );
      }
    }
    console.log("");
  }
  console.log(
    `Sum of median wall ms: ${VARIANTS.map((variant) => `${variant} ${totals.get(variant)!.toFixed(0)}`).join(", ")}`,
  );
}

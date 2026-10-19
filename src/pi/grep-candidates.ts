/**
 * Candidate selection: rg lists candidate lines through the rg-regex translation, or candidate
 * files through the prefilter's necessary literals, with conservative fallback and a
 * whole-scope scan budget. rg-process runs rg and parses its records; this module decides
 * which rg runs to make.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GrepQuery } from "../core/search.ts";
import { extractPrefilter, type Literal, type Prefilter } from "../core/search-analysis.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { scopeArgs, type SearchScope } from "./grep-scope.ts";
import {
  COMMON_RG_ARGS,
  LINE_LISTING_ARGS,
  MAX_RG_STDERR_BYTES,
  type GrepBackend,
  type RgRunResult,
} from "./rg-process.ts";
import { lineCandidatePatterns } from "./rg-regex.ts";

/** Beyond this many candidate lines, a file's every line is checked instead. */
const MAX_CANDIDATE_LINES = 64 * 1024;
/**
 * When every file in scope is a candidate, files stop being listed once this many bytes of
 * them were queued; README's search limits link here.
 */
export const MAX_UNNARROWED_SCAN_BYTES = 256 * 1024 * 1024;
/** Maximum retained paths while intersecting necessary file conditions. */
export const MAX_PREFILTER_PATH_BYTES = 4 * 1024 * 1024;
/** Candidate patterns match original bytes exactly as written; JavaScript decides case and encoding. */
const BYTE_PATTERN_ARGS = ["--engine=default", "--case-sensitive", "--encoding=none"];

/** An absolute file path to check: only its ascending candidate lines, or every line when absent. */
export interface Candidate {
  readonly filePath: string;
  readonly lines?: readonly number[];
}

/** A literal's characters as one rg pattern; every non-word character is a code point escape. */
function literalPattern(literal: Literal): string {
  const escape = (char: string) =>
    /^[0-9A-Za-z_]$/.test(char) ? char : `\\x{${char.codePointAt(0)!.toString(16)}}`;
  return literal
    .map((chars) => (chars.length === 1 ? escape(chars[0]) : `[${chars.map(escape).join("")}]`))
    .join("");
}

/**
 * List candidate files: those whose original bytes contain a prefilter literal, or every
 * file in scope. Literals never contain a line break, so line-oriented matching finds them.
 */
export function candidateArgs(prefilter: Prefilter): string[] {
  if (prefilter.kind === "and") return candidateArgs(prefilter.filters[0]);
  if (prefilter.kind === "all") return [...COMMON_RG_ARGS, "--files"];
  return [
    ...COMMON_RG_ARGS,
    "--files-with-matches",
    ...BYTE_PATTERN_ARGS,
    "-e",
    prefilter.literals.map(literalPattern).join("|"),
  ];
}

/** Execute AND-of-OR file conditions, falling back to one necessary clause if retention fills. */
export async function runCandidatePaths(
  run: GrepBackend["runRgPaths"],
  rgPath: string,
  prefilter: Prefilter,
  scopedArgs: readonly string[],
  signal: AbortSignal | undefined,
  onFile: (path: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  const filters = prefilter.kind === "and" ? prefilter.filters : [prefilter];
  const diagnostics = new DiagnosticBuffer(MAX_RG_STDERR_BYTES);
  let allowed: ReadonlySet<string> | undefined;
  for (const [index, filter] of filters.entries()) {
    const last = index === filters.length - 1;
    const paths = new Set<string>();
    let bytes = 0;
    let overflow = false;
    const result = await run(
      rgPath,
      [...candidateArgs(filter), "--null", ...scopedArgs],
      signal,
      async (path) => {
        if (allowed && !allowed.has(path)) return true;
        if (last) return onFile(path);
        if (!paths.has(path)) {
          paths.add(path);
          bytes += Buffer.byteLength(path);
        }
        overflow = bytes > MAX_PREFILTER_PATH_BYTES;
        return !overflow;
      },
    );
    if (result.stderr) diagnostics.append(`${result.stderr}\n`);
    if (overflow) {
      const fallback = await run(
        rgPath,
        [...candidateArgs(filters[0]), "--null", ...scopedArgs],
        signal,
        onFile,
      );
      if (fallback.stderr) diagnostics.append(fallback.stderr);
      return { ...fallback, stderr: diagnostics.toString() };
    }
    if (last || result.stopped || (result.code !== 0 && result.code !== 1)) {
      // An incomplete intermediate listing cannot exclude its already reported candidates.
      if (!last) for (const path of paths) if (!(await onFile(path))) break;
      return { ...result, stderr: diagnostics.toString() };
    }
    if (!paths.size) return { code: 1, stderr: diagnostics.toString(), stopped: false };
    allowed = paths;
  }
  return { code: 1, stderr: diagnostics.toString(), stopped: false };
}

/** How candidates were selected: rg's candidate lines, or whole files (see Prefilter). */
type CandidateSource = "lines" | "files" | "all";

/**
 * Await each consumer for backpressure; false stops listing. The caller owns worker cleanup.
 * An empty scope lists nothing, because rg would search the working directory instead.
 */
export async function listCandidates(options: {
  readonly backend: GrepBackend;
  readonly rgPath: string;
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly signal: AbortSignal;
  readonly onCandidate: (candidate: Candidate) => Promise<boolean>;
}): Promise<{
  readonly listing?: RgRunResult;
  readonly candidates: CandidateSource;
  readonly scanLimitReached: boolean;
}> {
  const { backend, rgPath, scope, query, signal, onCandidate } = options;
  if (scope.searchPaths.length === 0) return { candidates: "lines", scanLimitReached: false };
  let listedAny = false;
  const offer = (path: string, lines?: readonly number[]) => {
    listedAny = true;
    return onCandidate({ filePath: resolve(path), lines });
  };
  let candidates: CandidateSource = "lines";
  let scanned = 0;
  let scanLimitReached = false;
  const offerWithinBudget = async (path: string) => {
    if (scanned >= MAX_UNNARROWED_SCAN_BYTES) {
      scanLimitReached = true;
      return false;
    }
    scanned += await stat(resolve(path)).then(
      ({ size }) => size,
      // The search reports unreadable files; a failed size probe must not exclude them.
      () => 0,
    );
    return offer(path);
  };
  const scoped = [...scopeArgs(scope), "--", ...scope.searchPaths];
  const patterns = query.multiline ? undefined : lineCandidatePatterns(query);
  let listing = patterns
    ? await backend.runRgLines(
        rgPath,
        [
          ...COMMON_RG_ARGS,
          ...BYTE_PATTERN_ARGS,
          ...LINE_LISTING_ARGS,
          ...patterns.flatMap((pattern) => ["-e", pattern]),
          ...scoped,
        ],
        signal,
        MAX_CANDIDATE_LINES,
        offer,
      )
    : undefined;
  // rg reports a pattern it cannot compile, such as one beyond its size limit, before any file.
  if (!listing || (listing.code === 2 && !listedAny)) {
    const prefilter = extractPrefilter(query);
    candidates = prefilter.kind === "all" ? "all" : "files";
    listing = await runCandidatePaths(
      backend.runRgPaths,
      rgPath,
      prefilter,
      scoped,
      signal,
      candidates === "all" ? offerWithinBudget : (path) => offer(path),
    );
  }
  return { listing, candidates, scanLimitReached };
}

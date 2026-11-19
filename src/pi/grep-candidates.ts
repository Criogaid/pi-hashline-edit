/**
 * Candidate selection: rg lists candidate lines through the rg-regex translation, or candidate
 * files through the prefilter's necessary literals, with conservative fallback and a
 * whole-scope scan budget. This module deduplicates candidates before charging that budget.
 * rg-process runs rg and parses its records; this module decides which rg runs to make.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GrepQuery } from "../core/search.ts";
import { extractPrefilter, type Literal } from "../core/search-analysis.ts";
import { ListedFiles, scopeArgs, type SearchScope } from "./grep-scope.ts";
import {
  COMMON_RG_ARGS,
  isRgArgumentLimit,
  LINE_LISTING_ARGS,
  MAX_RG_PATTERN_UNITS,
  RG_PATTERN_FLAG,
  rgPatternArgUnits,
  rgRejectsPatterns,
  runRgLines,
  runRgPaths,
  type RgRunResult,
} from "./rg-process.ts";
import { lineCandidatePatterns, rgCodePoint } from "./rg-regex.ts";

/** Beyond this many candidate lines, a file's every line is checked instead. */
const MAX_CANDIDATE_LINES = 64 * 1024;
/**
 * When every file in scope is a candidate, files stop being listed once this many bytes of
 * them were queued; README's search limits link here.
 */
export const MAX_UNNARROWED_SCAN_BYTES = 256 * 1024 * 1024;
/** Candidate patterns match original bytes exactly as written; JavaScript decides case and encoding. */
const BYTE_PATTERN_ARGS = ["--engine=default", "--case-sensitive", "--encoding=none"];

/** An absolute file path to check: only its ascending candidate lines, or every line when absent. */
export interface Candidate {
  readonly filePath: string;
  readonly lines?: readonly number[];
}

/** A literal's characters as one rg pattern. */
function literalPattern(literal: Literal): string {
  const escape = (char: string) => rgCodePoint(char.codePointAt(0)!);
  return literal
    .map((chars) => (chars.length === 1 ? escape(chars[0]) : `[${chars.map(escape).join("")}]`))
    .join("");
}

const literalAlternation = (literals: readonly Literal[]): string =>
  literals.map(literalPattern).join("|");

/** A listing that narrows candidates with rg patterns; the next stage replaces it when rg cannot run them. */
interface PatternStage {
  readonly patternArgs: readonly string[];
  readonly list: () => Promise<RgRunResult>;
}

function widenOnArgumentLimit(error: unknown): undefined {
  if (isRgArgumentLimit(error)) return undefined;
  throw error;
}

/**
 * Await each consumer for backpressure; false stops listing. The caller owns worker cleanup.
 * An empty scope lists nothing, because rg would search the working directory instead.
 */
export async function listCandidates(options: {
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  readonly onCandidate: (candidate: Candidate) => Promise<boolean>;
}): Promise<{
  readonly listing?: RgRunResult;
  readonly scanLimitReached: boolean;
}> {
  const { scope, query, signal, stopped, onCandidate } = options;
  if (scope.searchPaths.length === 0) return { scanLimitReached: false };
  let scanAll = false;
  let listedAny = false;
  let scanned = 0;
  let scanLimitReached = false;
  const seen = new ListedFiles();
  const offer = async (path: string, lines?: readonly number[]) => {
    listedAny = true;
    if (stopped()) return false;
    const filePath = resolve(path);
    if (await seen.has(filePath)) return true;
    seen.add(filePath);
    if (scanAll) {
      if (scanned >= MAX_UNNARROWED_SCAN_BYTES) {
        scanLimitReached = true;
        return false;
      }
      scanned += await stat(filePath).then(
        ({ size }) => size,
        // The search reports unreadable files; a failed size probe must not exclude them.
        () => 0,
      );
    }
    return onCandidate({ filePath, lines });
  };
  const scoped = [...scopeArgs(scope), "--", ...scope.searchPaths];

  /** Narrowing listings, most selective first; each is derived only when the one before gives way. */
  function* patternStages(): Generator<PatternStage> {
    const patterns = query.multiline ? undefined : lineCandidatePatterns(query);
    if (patterns) {
      const patternArgs = patterns.flatMap((pattern) => [RG_PATTERN_FLAG, pattern]);
      yield {
        patternArgs,
        list: () =>
          runRgLines(
            [
              ...COMMON_RG_ARGS,
              ...BYTE_PATTERN_ARGS,
              ...LINE_LISTING_ARGS,
              ...patternArgs,
              ...scoped,
            ],
            signal,
            MAX_CANDIDATE_LINES,
            offer,
          ),
      };
    }
    const prefilter = extractPrefilter(query);
    if (prefilter.kind !== "literals") return;
    const pattern = literalAlternation(prefilter.literals);
    if (rgPatternArgUnits(pattern) > MAX_RG_PATTERN_UNITS) return;
    const patternArgs = [RG_PATTERN_FLAG, pattern];
    yield {
      patternArgs,
      list: () =>
        runRgPaths(
          [
            ...COMMON_RG_ARGS,
            "--files-with-matches",
            ...BYTE_PATTERN_ARGS,
            ...patternArgs,
            "--null",
            ...scoped,
          ],
          signal,
          offer,
        ),
    };
  }

  // A stage gives way when its arguments exceed the command line, or when rg exits with code 2
  // before offering any candidate because it rejects the patterns. A completed listing that only
  // hit unreadable paths also exits with 2, and stands.
  for (const { patternArgs, list } of patternStages()) {
    const listing = await list().catch(widenOnArgumentLimit);
    const givesWay =
      !listing ||
      (listing.code === 2 &&
        !listedAny &&
        (await rgRejectsPatterns([...BYTE_PATTERN_ARGS, ...patternArgs], signal)));
    if (!givesWay) return { listing, scanLimitReached };
  }
  scanAll = true;
  const listing = await runRgPaths(
    [...COMMON_RG_ARGS, "--files", "--null", ...scoped],
    signal,
    offer,
  );
  return { listing, scanLimitReached };
}

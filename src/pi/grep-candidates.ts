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
import { extractPrefilter, type Literal, type Prefilter } from "../core/search-analysis.ts";
import { scopeArgs, type SearchScope } from "./grep-scope.ts";
import {
  COMMON_RG_ARGS,
  LINE_LISTING_ARGS,
  MAX_RG_PATTERN_UNITS,
  type GrepBackend,
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

/** Necessary literals too long for rg's command line widen to every file in scope. */
function boundedPrefilter(prefilter: Prefilter): Prefilter {
  return prefilter.kind === "literals" &&
    literalAlternation(prefilter.literals).length > MAX_RG_PATTERN_UNITS
    ? { kind: "all" }
    : prefilter;
}

/**
 * List candidate files: those whose original bytes contain a prefilter literal, or every
 * file in scope. Literals never contain a line break, so line-oriented matching finds them.
 */
export function candidateArgs(prefilter: Prefilter): string[] {
  if (prefilter.kind === "all") return [...COMMON_RG_ARGS, "--files"];
  return [
    ...COMMON_RG_ARGS,
    "--files-with-matches",
    ...BYTE_PATTERN_ARGS,
    "-e",
    literalAlternation(prefilter.literals),
  ];
}

/** How candidates were selected: rg's candidate lines, or whole files (see Prefilter). */
type CandidateSource = "lines" | "files" | "all";

/**
 * Await each consumer for backpressure; false stops listing. The caller owns worker cleanup.
 * An empty scope lists nothing, because rg would search the working directory instead.
 */
export async function listCandidates(options: {
  readonly backend: GrepBackend;
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  readonly onCandidate: (candidate: Candidate) => Promise<boolean>;
}): Promise<{
  readonly listing?: RgRunResult;
  readonly candidates: CandidateSource;
  readonly scanLimitReached: boolean;
}> {
  const { backend, scope, query, signal, stopped, onCandidate } = options;
  if (scope.searchPaths.length === 0) return { candidates: "lines", scanLimitReached: false };
  let candidates: CandidateSource = "lines";
  let listedAny = false;
  let scanned = 0;
  let scanLimitReached = false;
  const seen = new Set<string>();
  const offer = async (path: string, lines?: readonly number[]) => {
    listedAny = true;
    if (stopped()) return false;
    const filePath = resolve(path);
    if (seen.has(filePath)) return true;
    seen.add(filePath);
    if (candidates === "all") {
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
  const patterns = query.multiline ? undefined : lineCandidatePatterns(query);
  let listing = patterns
    ? await backend.runRgLines(
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
    const prefilter = boundedPrefilter(extractPrefilter(query));
    candidates = prefilter.kind === "all" ? "all" : "files";
    listing = await backend.runRgPaths(
      [...candidateArgs(prefilter), "--null", ...scoped],
      signal,
      offer,
    );
  }
  return { listing, candidates, scanLimitReached };
}

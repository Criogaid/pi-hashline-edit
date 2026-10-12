/** Select candidate lines or files, with conservative fallback and a whole-scope scan budget. */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GrepQuery } from "../core/search.ts";
import { extractPrefilter } from "../core/search-analysis.ts";
import { scopeArgs, type SearchScope } from "./grep-scope.ts";
import {
  COMMON_RG_ARGS,
  LINE_LISTING_ARGS,
  runCandidatePaths,
  type GrepBackend,
} from "./rg-process.ts";
import { lineCandidatePatterns } from "./rg-regex.ts";

/** Beyond this many candidate lines, a file's every line is checked instead. */
const MAX_CANDIDATE_LINES = 64 * 1024;
/**
 * When every file in scope is a candidate, files stop being listed once this many bytes of
 * them were queued; README's search limits link here.
 */
export const MAX_UNNARROWED_SCAN_BYTES = 256 * 1024 * 1024;

/** An absolute file path to check: only its ascending candidate lines, or every line when absent. */
export interface Candidate {
  readonly filePath: string;
  readonly lines?: readonly number[];
}

/** Await each consumer for backpressure; false stops listing. The caller owns worker cleanup. */
export async function listCandidates(options: {
  readonly backend: GrepBackend;
  readonly rgPath: string;
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly signal: AbortSignal;
  readonly onCandidate: (candidate: Candidate) => Promise<boolean>;
}) {
  const { backend, rgPath, scope, query, signal, onCandidate } = options;
  let listedAny = false;
  const offer = (path: string, lines?: readonly number[]) => {
    listedAny = true;
    return onCandidate({ filePath: resolve(path), lines });
  };
  let candidates: "lines" | "files" | "all" = "lines";
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
          "--engine=default",
          "--case-sensitive",
          "--encoding=none",
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

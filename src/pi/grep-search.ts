import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { scanTextFile } from "./text-stream.ts";
import {
  type RgRunResult,
  matcherArgs,
  probeRegex,
  resolveIgnoreCase,
  rgBytes,
  rgText,
  runRgPaths,
  type SearchModes,
} from "./rg-process.ts";
import { submatchesToLineRanges } from "./rg-line-ranges.ts";
import { throwIfCancelled } from "./error-text.ts";

/** Surface incomplete search diagnostics without discarding confirmed matches. */
export function recordSearchDiagnostics(result: RgRunResult, warnings?: string[]): void {
  const message =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}`
      : "");
  if (!message) return;
  if (!warnings) throw new Error(message);
  warnings.push(message);
}

export interface RgMatch {
  filePath: string;
  lineNumber: number;
  column?: number;
  matchedText?: string;
}

interface RgJsonEvent {
  type: string;
  data?: {
    path?: Parameters<typeof rgText>[0];
    lines?: Parameters<typeof rgBytes>[0];
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

export interface SearchScope {
  globs: readonly string[];
  noIgnore: boolean;
  follow: boolean;
  searchPaths: readonly string[];
}

/** One JSONL content search, kept structured so the backend never re-parses rg arguments. */
export interface SearchRequest {
  /** Matcher and output arguments, including `-e` patterns; no scope flags or paths. */
  readonly matcher: readonly string[];
  readonly scope: SearchScope;
}

/** Runs a search request and streams rg JSONL lines to `onLine`; returning false stops rg. */
export type SearchRunner = (
  rgPath: string,
  request: SearchRequest,
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean | Promise<boolean>,
) => Promise<RgRunResult>;

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  search: SearchRunner;
  runRgPaths: typeof runRgPaths;
  resolveIgnoreCase: typeof resolveIgnoreCase;
  probeRegex: typeof probeRegex;
}

/** The only place scope becomes rg flags. */
export function scopeArgs(scope: SearchScope): string[] {
  return [
    "--hidden",
    ...(scope.noIgnore ? ["--no-ignore"] : []),
    ...(scope.follow ? ["--follow"] : []),
    ...scope.globs.flatMap((glob) => ["--glob", glob]),
  ];
}

interface SearchMatchesOptions {
  backend: GrepBackend;
  rgPath: string;
  scope: SearchScope;
  patterns: readonly string[];
  modes: SearchModes;
  limit: number;
  signal?: AbortSignal;
  warnings: string[];
}

async function scanFileRevision(filePath: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  const stats = await scanTextFile(
    filePath,
    undefined,
    signal,
    (bytes) => hash.update(bytes),
    "preview",
  );
  return { ...stats, revision: hash.digest("hex") };
}

export type SearchFileSnapshot = Awaited<ReturnType<typeof scanFileRevision>>;

export function fileReadWarning(
  filePath: string,
  error: unknown,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted || !(error instanceof Error) || !("code" in error)) return undefined;
  return `Could not read ${filePath}: ${error.message}`;
}

export async function searchMatches(options: SearchMatchesOptions) {
  const { backend, rgPath, scope, patterns, modes, limit, signal, warnings } = options;
  const raw: RgMatch[] = [];
  const snapshots = new Map<string, SearchFileSnapshot>();
  let matchLimitReached = false;
  const unreadableFiles = new Set<string>();
  const seenMatches = new Set<string>();
  // rg reports non-overlapping spans, so overlapping multiline OR patterns need separate scans.
  const patternGroups = modes.multiline ? patterns.map((pattern) => [pattern]) : [patterns];
  for (const group of patternGroups) {
    const matcher = [
      ...matcherArgs(modes),
      "--json",
      "--line-number",
      ...group.flatMap((pattern) => ["-e", pattern]),
    ];
    const run = await backend.search(rgPath, { matcher, scope }, signal, async (line) => {
      if (raw.length >= limit) return false;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      if (event.type !== "match") return true;
      const data = event.data;
      if (
        !data?.path ||
        !data.lines ||
        typeof data.line_number !== "number" ||
        !Number.isSafeInteger(data.line_number)
      )
        return true;
      const filePath = resolve(rgText(data.path));
      if (unreadableFiles.has(filePath)) return true;
      let snapshot = snapshots.get(filePath);
      if (!snapshot) {
        try {
          snapshot = await scanFileRevision(filePath, signal);
          if (snapshot.hasNul) {
            unreadableFiles.add(filePath);
            return true;
          }
          snapshots.set(filePath, snapshot);
        } catch (error) {
          const warning = fileReadWarning(filePath, error, signal);
          if (!warning) throw error;
          warnings.push(warning);
          unreadableFiles.add(filePath);
          return true;
        }
      }
      const startLine = data.line_number;
      const bytes = rgBytes(data.lines);
      const text = bytes.toString("utf8");
      // Valid text is already the LF view; normalizing it twice would strip a content CR.
      const matchedText = (snapshot.validUtf8 ? text : normalizeLineEndings(text)).replace(
        /\n$/,
        "",
      );
      const addMatch = (match: RgMatch) => {
        const matchKey = `${filePath}\0${match.lineNumber}`;
        if (seenMatches.has(matchKey)) return true;
        seenMatches.add(matchKey);
        raw.push(match);
        if (raw.length >= limit) {
          matchLimitReached = true;
          return false;
        }
        return true;
      };
      if (!modes.multiline) {
        return addMatch({
          filePath,
          lineNumber: startLine,
          column: bytes.subarray(0, data.submatches?.[0]?.start ?? 0).toString("utf8").length,
          matchedText,
        });
      }
      if (!Array.isArray(data.submatches)) throw new Error("Invalid rg multiline match event");
      const columns = new Map<number, number>();
      const submatches = data.submatches.length ? data.submatches : [{ start: 0, end: 0 }];
      const ranges = submatchesToLineRanges(
        bytes,
        startLine,
        submatches,
        snapshot.totalLines,
        columns,
      );
      const texts = matchedText.split("\n");
      for (const [start, end] of ranges) {
        for (let lineNumber = start; lineNumber < end; lineNumber++) {
          if (
            !addMatch({
              filePath,
              lineNumber,
              column: columns.get(lineNumber),
              matchedText: texts[lineNumber - startLine],
            })
          )
            return false;
        }
      }
      return true;
    });
    throwIfCancelled(signal);
    recordSearchDiagnostics(run, warnings);
    if (matchLimitReached) break;
  }
  return { raw, matchLimitReached, snapshots };
}

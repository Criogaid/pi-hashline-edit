import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { scanTextFile } from "./text-stream.ts";
import {
  type RgRunResult,
  matcherArgs,
  probeRegex,
  rgBytes,
  rgText,
  ripgrepFailure,
  runRg,
  runRgPaths,
} from "./rg-process.ts";
import { submatchesToLineRanges } from "./rg-line-ranges.ts";
import { rawMatchRevision, type RawMatchRevision } from "./rg-match-bytes.ts";
import { throwIfCancelled } from "./error-text.ts";
import type { RgMatcher } from "./rg-regex.ts";

/** Surface incomplete search diagnostics without discarding confirmed matches. */
export function recordSearchDiagnostics(result: RgRunResult, warnings: string[]): void {
  const message =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}.`
      : "");
  if (message) warnings.push(message);
}

export interface RgMatch {
  filePath: string;
  lineNumber: number;
  column?: number;
  matchedText?: string;
  /** Shared whole-event digest: a limited row still depends on every byte in its raw match. */
  rawMatch?: RawMatchRevision;
}

interface RgJsonEvent {
  type: string;
  data?: {
    path?: Parameters<typeof rgText>[0];
    lines?: Parameters<typeof rgBytes>[0];
    line_number?: number;
    absolute_offset?: number;
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
  readonly matcher: RgMatcher;
  readonly scope: SearchScope;
}

/** Runs a search request and streams rg JSONL lines to `onLine`; returning false stops rg. */
export type SearchRunner = (
  rgPath: string,
  request: SearchRequest,
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean | Promise<boolean>,
) => Promise<RgRunResult>;

/** Search the original files; --crlf in the matcher makes CRLF one line break. */
export const runRgSearch: SearchRunner = (rgPath, { matcher, scope }, signal, onLine) =>
  runRg(
    rgPath,
    [
      ...matcherArgs(matcher),
      "--json",
      "--line-number",
      ...scopeArgs(scope),
      "--",
      ...scope.searchPaths,
    ],
    signal,
    onLine,
  );

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  search: SearchRunner;
  runRgPaths: typeof runRgPaths;
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
  /** Scanned in order; translateQuery decides how patterns share a scan. */
  matchers: readonly RgMatcher[];
  limit: number;
  signal?: AbortSignal;
  warnings: string[];
}

/** A matched file when its first match arrived; content output re-verifies it before display. */
export interface SearchFileSnapshot {
  revision: string;
  validUtf8: boolean;
  totalLines: number;
}

/** Snapshot a matched file; undefined when it contains NUL and must be skipped. */
async function scanFileSnapshot(
  filePath: string,
  signal?: AbortSignal,
): Promise<SearchFileSnapshot | undefined> {
  const hash = createHash("sha256");
  const stats = await scanTextFile(
    filePath,
    undefined,
    signal,
    (bytes) => hash.update(bytes),
    "lossy",
  );
  if (stats.hasNul) return undefined;
  return { revision: hash.digest("hex"), validUtf8: stats.validUtf8, totalLines: stats.totalLines };
}

export function fileReadWarning(
  filePath: string,
  error: unknown,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted || !(error instanceof Error) || !("code" in error)) return undefined;
  return `Could not read ${filePath}: ${error.message}`;
}

export async function searchMatches(options: SearchMatchesOptions) {
  const { backend, rgPath, scope, matchers, limit, signal, warnings } = options;
  const raw: RgMatch[] = [];
  // Every matched file is read once: NUL files are skipped, and validity decides anchors.
  const snapshots = new Map<string, SearchFileSnapshot>();
  let matchLimitReached = false;
  const unreadableFiles = new Set<string>();
  const seenMatches = new Set<string>();
  for (const matcher of matchers) {
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
          snapshot = await scanFileSnapshot(filePath, signal);
          if (!snapshot) {
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
      // Invalid UTF-8 rows have no anchors, so their exact match bytes are verified instead.
      const rawMatch = snapshot.validUtf8
        ? undefined
        : rawMatchRevision(bytes, startLine, data.absolute_offset);
      const matchedText = normalizeLineEndings(bytes.toString("utf8")).replace(/\n$/, "");
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
      if (!matcher.multiline) {
        return addMatch({
          filePath,
          lineNumber: startLine,
          column: bytes.subarray(0, data.submatches?.[0]?.start ?? 0).toString("utf8").length,
          matchedText,
          rawMatch,
        });
      }
      if (!Array.isArray(data.submatches))
        throw ripgrepFailure("Invalid rg multiline match event.");
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
              rawMatch,
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

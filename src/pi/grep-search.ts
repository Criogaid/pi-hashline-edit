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
import { rawMatchRevision, type RawMatchRevision } from "./rg-match-bytes.ts";
import { searchChangedError, throwIfCancelled } from "./error-text.ts";

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
  /** Matcher and output arguments, including `-e` patterns; no scope flags or paths. */
  readonly matcher: readonly string[];
  /** Original patterns for raw-byte files; omitted when they equal the LF-view patterns. */
  readonly rawMatcher?: readonly string[];
  readonly scope: SearchScope;
}

export type SearchTextView = { kind: "lf" } | { kind: "raw"; snapshot: SearchFileSnapshot };

/** Runs a search request and streams rg JSONL lines to `onLine`; returning false stops rg. */
export type SearchRunner = (
  rgPath: string,
  request: SearchRequest,
  signal: AbortSignal | undefined,
  onLine: (line: string, view: SearchTextView) => boolean | Promise<boolean>,
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
  outputMode: "content" | "files" | "count";
  signal?: AbortSignal;
  warnings: string[];
}

/** What a matched file looked like when searched; content output re-verifies it before display. */
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
  const { backend, rgPath, scope, patterns, modes, limit, outputMode, signal, warnings } = options;
  // Content rows and multiline line mapping read the file; the text view already skips NUL files.
  const needsSnapshot = outputMode === "content" || modes.multiline;
  const raw: RgMatch[] = [];
  const snapshots = new Map<string, SearchFileSnapshot>();
  let matchLimitReached = false;
  const unreadableFiles = new Set<string>();
  const seenMatches = new Set<string>();
  // rg reports non-overlapping spans, so overlapping multiline OR patterns need separate scans.
  const patternGroups = modes.multiline ? patterns.map((pattern) => [pattern]) : [patterns];
  for (const group of patternGroups) {
    const args = [...matcherArgs(modes), "--json", "--line-number"];
    const normalized = group.map(normalizeLineEndings);
    const matcher = [...args, ...normalized.flatMap((pattern) => ["-e", pattern])];
    const request: SearchRequest = {
      matcher,
      scope,
      ...(group.some((pattern, index) => pattern !== normalized[index])
        ? { rawMatcher: [...args, ...group.flatMap((pattern) => ["-e", pattern])] }
        : {}),
    };
    const run = await backend.search(rgPath, request, signal, async (line, view) => {
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
      if (view.kind === "raw") {
        if (snapshot && snapshot.revision !== view.snapshot.revision) throw searchChangedError();
        snapshot = view.snapshot;
        snapshots.set(filePath, snapshot);
      }
      if (!snapshot && needsSnapshot) {
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
      if (snapshot && snapshot.validUtf8 !== (view.kind === "lf")) throw searchChangedError();
      const startLine = data.line_number;
      const bytes = rgBytes(data.lines);
      const text = bytes.toString("utf8");
      const rawMatch =
        view.kind === "raw" ? rawMatchRevision(bytes, startLine, data.absolute_offset) : undefined;
      // Valid text is already the LF view; normalizing it twice would strip a content CR.
      const matchedText = (view.kind === "raw" ? normalizeLineEndings(text) : text).replace(
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
          rawMatch,
        });
      }
      if (!Array.isArray(data.submatches)) throw new Error("Invalid rg multiline match event");
      const columns = new Map<number, number>();
      const submatches = data.submatches.length ? data.submatches : [{ start: 0, end: 0 }];
      const ranges = submatchesToLineRanges(
        bytes,
        startLine,
        submatches,
        // Multiline always loads a snapshot above.
        snapshot!.totalLines,
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

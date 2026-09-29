import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { scanTextFile } from "./text-stream.ts";
import {
  type RgRunResult,
  matcherArgs,
  resolveIgnoreCase,
  rgBytes,
  rgText,
  runRg,
  runRgPaths,
  type SearchModes,
} from "./rg-line-filter.ts";
import { submatchesToLineRanges } from "./rg-line-ranges.ts";

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

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  runRg: typeof runRg;
  runRgPaths: typeof runRgPaths;
  resolveIgnoreCase: typeof resolveIgnoreCase;
}

export interface SearchScope {
  globs: readonly string[];
  noIgnore: boolean;
  follow: boolean;
  searchPaths: readonly string[];
}

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

async function scanFileRevision(filePath: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  const stats = await scanTextFile(filePath, undefined, signal, (bytes) => hash.update(bytes));
  return { ...stats, revision: hash.digest("hex") };
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
  const raw: RgMatch[] = [];
  const revisions = new Map<string, string>();
  const lineCounts = new Map<string, number>();
  let matchLimitReached = false;
  const unreadableFiles = new Set<string>();
  const seenMatches = new Set<string>();
  // rg reports non-overlapping spans, so overlapping multiline OR patterns need separate scans.
  const patternGroups = modes.multiline ? patterns.map((pattern) => [pattern]) : [patterns];
  for (const group of patternGroups) {
    const args = [
      ...matcherArgs(modes),
      "--json",
      "--line-number",
      ...scopeArgs(scope),
      ...group.flatMap((pattern) => ["-e", pattern]),
      "--",
      ...scope.searchPaths,
    ];
    const run = await backend.runRg(rgPath, args, signal, async (line) => {
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
      const startLine = data.line_number;
      const bytes = rgBytes(data.lines);
      const addMatch = async (match: RgMatch) => {
        if (unreadableFiles.has(filePath)) return true;
        const matchKey = `${filePath}\0${match.lineNumber}`;
        if (seenMatches.has(matchKey)) return true;
        seenMatches.add(matchKey);
        if (outputMode === "content" && !revisions.has(filePath)) {
          try {
            const stats = await scanFileRevision(filePath, signal);
            if (stats.hasNul) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
            revisions.set(filePath, stats.revision);
          } catch (error) {
            const warning = fileReadWarning(filePath, error, signal);
            if (!warning) throw error;
            warnings.push(warning);
            unreadableFiles.add(filePath);
            return true;
          }
        }
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
          matchedText: bytes.toString("utf8").replace(/\n$/, ""),
        });
      }
      if (unreadableFiles.has(filePath)) return true;
      if (!Array.isArray(data.submatches)) throw new Error("Invalid rg multiline match event");
      let lineCount = lineCounts.get(filePath);
      if (lineCount === undefined) {
        try {
          const stats =
            outputMode === "content"
              ? await scanFileRevision(filePath, signal)
              : await scanTextFile(filePath, undefined, signal);
          if (stats.hasNul) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
          lineCount = stats.totalLines;
          lineCounts.set(filePath, lineCount);
          if ("revision" in stats && typeof stats.revision === "string") {
            revisions.set(filePath, stats.revision);
          }
        } catch (error) {
          const warning = fileReadWarning(filePath, error, signal);
          if (!warning) throw error;
          warnings.push(warning);
          unreadableFiles.add(filePath);
          return true;
        }
      }
      const columns = new Map<number, number>();
      const submatches = data.submatches.length ? data.submatches : [{ start: 0, end: 0 }];
      const ranges = submatchesToLineRanges(bytes, startLine, submatches, lineCount, columns);
      const texts = bytes.toString("utf8").replace(/\n$/, "").split("\n");
      for (const [start, end] of ranges) {
        for (let lineNumber = start; lineNumber < end; lineNumber++) {
          if (
            !(await addMatch({
              filePath,
              lineNumber,
              column: columns.get(lineNumber),
              matchedText: texts[lineNumber - startLine],
            }))
          )
            return false;
        }
      }
      return true;
    });
    if (signal?.aborted) throw new Error("Operation aborted");
    recordSearchDiagnostics(run, warnings);
    if (matchLimitReached) break;
  }
  return { raw, matchLimitReached, revisions };
}

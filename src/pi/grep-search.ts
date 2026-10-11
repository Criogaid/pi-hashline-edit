/**
 * grep's one search path: rg lists candidate files through the prefilter, and native
 * RegExp in a bounded worker pool decides every match on each file's LF view. Each
 * matched file keeps the revision of the bytes it was matched against.
 *
 * @module pi-hashline-edit/pi
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import type { GrepQuery, SearchInput } from "../core/search.ts";
import { extractPrefilter } from "../core/search-analysis.ts";
import { SEARCH_RESULT_SCHEMA, type SearchResult } from "../core/search-schema.ts";
import { scanTextFile } from "./text-stream.ts";
import { candidateArgs, type RgRunResult, runRgPaths } from "./rg-process.ts";
import { withRegexWorker } from "./regex-worker.ts";
import { invalidWorkerResult, workerReplyDecoder } from "./regex-worker-contract.ts";
import { throwIfCancelled } from "./error-text.ts";

/** Surface incomplete search diagnostics without discarding confirmed matches. */
export function recordSearchDiagnostics(result: RgRunResult, warnings: string[]): void {
  const message =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}.`
      : "");
  if (message) warnings.push(message);
}

/** One matching physical line; column counts UTF-16 units of the LF view. */
export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  column: number;
}

export interface SearchScope {
  globs: readonly string[];
  noIgnore: boolean;
  follow: boolean;
  searchPaths: readonly string[];
}

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  runRgPaths: typeof runRgPaths;
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

/** A matched file as it was searched; output re-verifies it before display. */
export interface SearchFileSnapshot {
  revision: string;
  validUtf8: boolean;
  totalLines: number;
}

export function fileReadWarning(
  filePath: string,
  error: unknown,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted || !(error instanceof Error) || !("code" in error)) return undefined;
  return `Could not read ${filePath}: ${error.message}`;
}

/** Whole-file input of a multiline query; README's search limits link here. */
export const MAX_MULTILINE_SEARCH_BYTES = 64 * 1024 * 1024;
/** Line-mode requests end after a line feed once they reach this many UTF-16 units. */
const SEARCH_CHUNK_UNITS = 1024 * 1024;
/** A line-mode request holds whole lines, so one line may not exceed the multiline limit. */
const MAX_SEARCH_LINE_UNITS = MAX_MULTILINE_SEARCH_BYTES;
const MAX_SEARCH_HEAP_MB = 512;
const MAX_SEARCH_WORKERS = 4;
const SEARCH_WORKERS = Math.max(1, Math.min(MAX_SEARCH_WORKERS, availableParallelism() - 1));

class SearchFileLimitError extends Error {
  constructor(multiline: boolean) {
    const limit = `${MAX_MULTILINE_SEARCH_BYTES / 1024 ** 2} MiB`;
    super(
      multiline
        ? `Multiline search requires a file of at most ${limit}.`
        : `Search requires lines of at most ${limit}.`,
    );
  }
}

/** A worker failure inside a file scan; it fails the search instead of becoming a read warning. */
class WorkerFailure {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

const decodeReply = workerReplyDecoder(SEARCH_RESULT_SCHEMA);
type Rows = SearchResult["lines"];
type Run = (input: SearchInput) => Promise<SearchResult>;

function physicalLines(text: string): number {
  let lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  return lines + (text && !text.endsWith("\n") ? 1 : 0);
}

/**
 * Match one file. Without multiline each line matches alone, so requests split after a
 * line feed; a multiline query sends the whole file. Undefined when the file has NUL.
 */
async function searchFile(
  filePath: string,
  query: GrepQuery,
  room: () => number,
  run: Run,
  signal: AbortSignal,
): Promise<{ rows: Rows; snapshot: SearchFileSnapshot } | undefined> {
  if (query.multiline && (await stat(filePath)).size > MAX_MULTILINE_SEARCH_BYTES)
    throw new SearchFileLimitError(true);
  const hash = createHash("sha256");
  const rows: Rows = [];
  let lineOffset = 0;
  const send = async (source: string) => {
    const lines = physicalLines(source);
    const limit = room() - rows.length;
    if (lines > 0 && limit > 0) {
      let result: SearchResult;
      try {
        result = await run({ source, query, limit });
      } catch (error) {
        throw new WorkerFailure(error);
      }
      if (result.totalLines !== lines || result.lines.length > limit) throw invalidWorkerResult();
      let previous = 0;
      for (const { lineNumber, column } of result.lines) {
        if (lineNumber <= previous || lineNumber > lines || column > source.length)
          throw invalidWorkerResult();
        previous = lineNumber;
        rows.push({ lineNumber: lineOffset + lineNumber, column });
      }
    }
    lineOffset += lines;
  };

  let pending = "";
  /** Length of pending through its last line feed. */
  let complete = 0;
  let bytes = 0;
  const stats = await scanTextFile(
    filePath,
    async (text) => {
      if (query.multiline) {
        if (bytes <= MAX_MULTILINE_SEARCH_BYTES) pending += text;
        return;
      }
      const lf = text.lastIndexOf("\n");
      if (lf !== -1) complete = pending.length + lf + 1;
      pending += text;
      if (pending.length - complete > MAX_SEARCH_LINE_UNITS) throw new SearchFileLimitError(false);
      if (complete >= SEARCH_CHUNK_UNITS) {
        const source = pending.slice(0, complete);
        pending = pending.slice(complete);
        complete = 0;
        await send(source);
      }
    },
    signal,
    (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    },
    "lossy",
  );
  if (stats.hasNul) return undefined;
  if (bytes > MAX_MULTILINE_SEARCH_BYTES && query.multiline) throw new SearchFileLimitError(true);
  await send(pending);
  return {
    rows,
    snapshot: {
      revision: hash.digest("hex"),
      validUtf8: stats.validUtf8,
      totalLines: stats.totalLines,
    },
  };
}

/**
 * Search every candidate file in scope. Paths stream from rg into a queue that at most
 * SEARCH_WORKERS workers drain; a worker starts only when no idle one can take a path.
 */
export async function searchFiles(options: {
  readonly backend: GrepBackend;
  readonly rgPath: string;
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly warnings: string[];
}) {
  const { backend, rgPath, scope, query, limit, timeoutMs, signal, warnings } = options;
  const raw: GrepMatch[] = [];
  const snapshots = new Map<string, SearchFileSnapshot>();
  let matchLimitReached = false;
  let failure: { error: unknown } | undefined;
  const failed = new AbortController();
  const poolSignal = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  const fail = (error: unknown) => {
    failure ??= { error };
    failed.abort();
  };

  const queue: string[] = [];
  let listed = false;
  const idle: (() => void)[] = [];
  const space: (() => void)[] = [];
  const stopped = () => failure !== undefined || matchLimitReached;
  const releaseAll = () => {
    for (const wake of idle.splice(0)) wake();
    for (const wake of space.splice(0)) wake();
  };
  const next = async (): Promise<string | undefined> => {
    while (!queue.length && !listed && !stopped())
      await new Promise<void>((wake) => idle.push(wake));
    space.shift()?.();
    return stopped() ? undefined : queue.shift();
  };

  const searchPath = async (filePath: string, run: Run) => {
    let found: Awaited<ReturnType<typeof searchFile>>;
    try {
      found = await searchFile(filePath, query, () => limit - raw.length, run, poolSignal);
    } catch (error) {
      if (error instanceof WorkerFailure) throw error.error;
      const warning =
        error instanceof SearchFileLimitError
          ? `${filePath}: ${error.message}`
          : fileReadWarning(filePath, error, poolSignal);
      if (!warning) throw error;
      warnings.push(warning);
      return;
    }
    const room = limit - raw.length;
    if (!found?.rows.length || room <= 0) return;
    snapshots.set(filePath, found.snapshot);
    for (const row of found.rows.slice(0, room)) raw.push({ ...row, filePath });
    if (raw.length >= limit) {
      matchLimitReached = true;
      releaseAll();
    }
  };

  const workers: Promise<void>[] = [];
  const startWorker = () =>
    withRegexWorker<SearchInput, SearchResult, void>(
      new URL("./grep-worker.mjs", import.meta.url),
      decodeReply,
      timeoutMs,
      poolSignal,
      async (run) => {
        for (let path = await next(); path !== undefined; path = await next())
          await searchPath(path, run);
      },
      { maxOldGenerationSizeMb: MAX_SEARCH_HEAP_MB },
    ).catch((error) => {
      fail(error);
      releaseAll();
    });

  const seen = new Set<string>();
  try {
    const listing = await backend.runRgPaths(
      rgPath,
      [
        ...candidateArgs(extractPrefilter(query)),
        "--null",
        ...scopeArgs(scope),
        "--",
        ...scope.searchPaths,
      ],
      poolSignal,
      async (path) => {
        const filePath = resolve(path);
        if (stopped()) return false;
        if (seen.has(filePath)) return true;
        seen.add(filePath);
        queue.push(filePath);
        if (idle.length) idle.shift()!();
        else if (workers.length < SEARCH_WORKERS) workers.push(startWorker());
        while (queue.length >= SEARCH_WORKERS && !stopped())
          await new Promise<void>((wake) => space.push(wake));
        return !stopped();
      },
    );
    recordSearchDiagnostics(listing, warnings);
  } catch (error) {
    fail(error);
  } finally {
    listed = true;
    releaseAll();
  }
  await Promise.all(workers);
  throwIfCancelled(signal);
  if (failure) throw failure.error;
  return { raw, snapshots, matchLimitReached };
}

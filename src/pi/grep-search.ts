/**
 * grep's search path: rg lists candidates and native RegExp in a bounded worker pool decides
 * every match on each file's LF view. Without multiline, rg lists candidate lines through
 * the translation in rg-regex.ts, which matches at least every line the query matches, and
 * workers check only those lines; a multiline query, or one rg cannot compile, lists
 * candidate files through the prefilter and workers check every line. Each matched file
 * keeps the revision of the bytes it was matched against.
 *
 * @module pi-hashline-edit/pi
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import type { GrepQuery, LineSearchInput, SearchInput } from "../core/search.ts";
import { extractPrefilter } from "../core/search-analysis.ts";
import { SEARCH_RESULT_SCHEMA, type SearchResult } from "../core/search-schema.ts";
import { scanTextFile } from "./text-stream.ts";
import {
  runCandidatePaths,
  COMMON_RG_ARGS,
  LINE_LISTING_ARGS,
  recordSearchDiagnostics,
  type GrepBackend,
} from "./rg-process.ts";
import { scopeArgs, type SearchScope } from "./grep-scope.ts";
import { lineCandidatePatterns } from "./rg-regex.ts";
import { withRegexWorker } from "./regex-worker.ts";
import { invalidWorkerResult, workerReplyDecoder } from "./regex-worker-contract.ts";
import { throwIfCancelled } from "./error-text.ts";
import { HashlineError } from "../core/errors.ts";

/** Matching physical lines in ascending order, with the revision they were searched against. */
export interface GrepFileMatch {
  readonly filePath: string;
  readonly rows: readonly SearchResult["lines"][number][];
  readonly snapshot: SearchFileSnapshot;
}

/** A matched file as it was searched; content output re-verifies it before display. */
interface SearchFileSnapshot {
  readonly revision: string;
  readonly validUtf8: boolean;
  readonly totalLines: number;
}

/**
 * A per-file failure that leaves the rest of the search valid: a filesystem error, or the
 * file changing while it was searched or displayed. Undefined for any other failure.
 */
export function fileReadWarning(
  filePath: string,
  error: unknown,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted || !(error instanceof Error)) return undefined;
  const changed = error instanceof HashlineError && error.errorCode === "FILE_CHANGED";
  if (!changed && !("code" in error)) return undefined;
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
/** Beyond this many candidate lines, a file's every line is checked instead. */
const MAX_CANDIDATE_LINES = 64 * 1024;
const SEARCH_WORKERS = Math.max(1, Math.min(MAX_SEARCH_WORKERS, availableParallelism() - 1));
/**
 * When every file in scope is a candidate, files stop being listed once this many bytes of
 * them were queued; README's search limits link here.
 */
export const MAX_UNNARROWED_SCAN_BYTES = 256 * 1024 * 1024;

/** How candidates were selected: rg's candidate lines, or whole files (see Prefilter). */
export type CandidateSource = "lines" | "files" | "all";

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
type Run = (input: SearchInput | LineSearchInput) => Promise<SearchResult>;

/** A file to check: only its candidate lines, ascending, or every line when absent. */
interface Candidate {
  filePath: string;
  lines?: readonly number[];
}

/**
 * The candidate lines among the next lines of a request source, as the LF view shows them.
 * `next` indexes the first candidate in source; a returned line number is 1-based in source.
 * `lengths` holds each selected line's length, and `lines` the lines a worker matches.
 */
function selectLines(source: string, offset: number, wanted: readonly number[], next: number) {
  const numbers: number[] = [];
  const lengths: number[] = [];
  const texts: string[] = [];
  let start = 0;
  let line = offset + 1;
  for (; next < wanted.length; next++) {
    while (line < wanted[next] && start < source.length) {
      const lf = source.indexOf("\n", start);
      start = lf === -1 ? source.length : lf + 1;
      line++;
    }
    if (start >= source.length) break;
    const lf = source.indexOf("\n", start);
    // A CRLF line feeds its view without the CR; a CR before the end of the file stays.
    const end = lf === -1 ? source.length : source[lf - 1] === "\r" ? lf - 1 : lf;
    numbers.push(line - offset);
    lengths.push(end - start);
    texts.push(source.slice(start, end), "\n");
  }
  return { numbers, lengths, lines: texts.join("") };
}

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
  { filePath, lines: wanted }: Candidate,
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
  let nextWanted = 0;
  const check = async (input: SearchInput | LineSearchInput, lines: number) => {
    let result: SearchResult;
    try {
      result = await run(input);
    } catch (error) {
      throw new WorkerFailure(error);
    }
    if (result.totalLines !== lines || result.lines.length > input.limit)
      throw invalidWorkerResult();
    let previous = 0;
    for (const row of result.lines) {
      if (row.lineNumber <= previous || row.lineNumber > lines) throw invalidWorkerResult();
      previous = row.lineNumber;
    }
    return result.lines;
  };
  const send = async (source: string) => {
    const lines = physicalLines(source);
    let candidates = lines;
    if (wanted) {
      let end = nextWanted;
      while (end < wanted.length && wanted[end] <= lineOffset + lines) end++;
      candidates = end - nextWanted;
    }
    const limit = room() - rows.length;
    if (candidates > 0 && limit > 0) {
      // Selecting most lines costs more than matching them all, with the same results.
      if (wanted && candidates * 2 <= lines) {
        const selected = selectLines(source, lineOffset, wanted, nextWanted);
        const found = await check({ lines: selected.lines, query, limit }, candidates);
        for (const { lineNumber, column } of found) {
          if (column > selected.lengths[lineNumber - 1]) throw invalidWorkerResult();
          rows.push({ lineNumber: lineOffset + selected.numbers[lineNumber - 1], column });
        }
      } else {
        for (const { lineNumber, column } of await check({ source, query, limit }, lines)) {
          if (column > source.length) throw invalidWorkerResult();
          rows.push({ lineNumber: lineOffset + lineNumber, column });
        }
      }
    }
    if (wanted) nextWanted += candidates;
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
  const files: GrepFileMatch[] = [];
  let matches = 0;
  let matchLimitReached = false;
  let failure: { error: unknown } | undefined;
  const failed = new AbortController();
  const poolSignal = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  const fail = (error: unknown) => {
    failure ??= { error };
    failed.abort();
  };

  const queue: Candidate[] = [];
  let listed = false;
  const idle: (() => void)[] = [];
  const space: (() => void)[] = [];
  const stopped = () => failure !== undefined || matchLimitReached;
  const releaseAll = () => {
    for (const wake of idle.splice(0)) wake();
    for (const wake of space.splice(0)) wake();
  };
  const next = async (): Promise<Candidate | undefined> => {
    while (!queue.length && !listed && !stopped())
      await new Promise<void>((wake) => idle.push(wake));
    space.shift()?.();
    return stopped() ? undefined : queue.shift();
  };

  const searchPath = async (candidate: Candidate, run: Run) => {
    const { filePath } = candidate;
    let found: Awaited<ReturnType<typeof searchFile>>;
    try {
      found = await searchFile(candidate, query, () => limit - matches, run, poolSignal);
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
    const room = limit - matches;
    if (!found?.rows.length || room <= 0) return;
    const rows = found.rows.slice(0, room);
    files.push({ filePath, rows, snapshot: found.snapshot });
    matches += rows.length;
    if (matches >= limit) {
      matchLimitReached = true;
      releaseAll();
    }
  };

  const workers: Promise<void>[] = [];
  const startWorker = () =>
    withRegexWorker<SearchInput | LineSearchInput, SearchResult, void>(
      new URL("./grep-worker.mjs", import.meta.url),
      decodeReply,
      timeoutMs,
      poolSignal,
      async (run) => {
        for (let file = await next(); file !== undefined; file = await next())
          await searchPath(file, run);
      },
      { maxOldGenerationSizeMb: MAX_SEARCH_HEAP_MB },
    ).catch((error) => {
      fail(error);
      releaseAll();
    });

  const seen = new Set<string>();
  let listedAny = false;
  const enqueue = async (path: string, lines?: readonly number[]) => {
    listedAny = true;
    const filePath = resolve(path);
    if (stopped()) return false;
    if (seen.has(filePath)) return true;
    seen.add(filePath);
    queue.push({ filePath, lines });
    if (idle.length) idle.shift()!();
    else if (workers.length < SEARCH_WORKERS) workers.push(startWorker());
    while (queue.length >= SEARCH_WORKERS && !stopped())
      await new Promise<void>((wake) => space.push(wake));
    return !stopped();
  };
  let candidates: CandidateSource = "lines";
  let scanned = 0;
  let scanLimitReached = false;
  /** Every file is a candidate: stop listing once the scan budget is spent. */
  const enqueueWithinBudget = async (path: string) => {
    if (scanned >= MAX_UNNARROWED_SCAN_BYTES) {
      scanLimitReached = true;
      return false;
    }
    scanned += await stat(resolve(path)).then(
      ({ size }) => size,
      () => 0,
    );
    return enqueue(path);
  };
  const scoped = [...scopeArgs(scope), "--", ...scope.searchPaths];
  try {
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
          poolSignal,
          MAX_CANDIDATE_LINES,
          enqueue,
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
        poolSignal,
        candidates === "all" ? enqueueWithinBudget : (path) => enqueue(path),
      );
    }
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
  return { files, matchLimitReached, candidates, scanLimitReached };
}

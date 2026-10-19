/**
 * Native RegExp matching in a bounded worker pool. grep-candidates supplies absolute paths
 * and optional candidate lines; this module owns queue backpressure, deduplication, worker
 * cleanup, and each matched file's revision.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { countLines } from "../core/lines.ts";
import type { GrepQuery, LineSearchInput, SearchInput } from "../core/search.ts";
import { SEARCH_RESULT_SCHEMA, type SearchResult } from "../core/search-schema.ts";
import { scanTextFile } from "./text-stream.ts";
import { recordSearchDiagnostics, type GrepBackend } from "./rg-process.ts";
import type { SearchScope } from "./grep-scope.ts";
import { listCandidates, type Candidate } from "./grep-candidates.ts";
import { withRegexWorker } from "./regex-worker.ts";
import { invalidWorkerResult, workerReplyDecoder } from "./regex-worker-contract.ts";
import { fileReadWarning, throwIfCancelled } from "./error-text.ts";

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
/** Listed files that may wait, searched or not, for an earlier file's result to commit. */
const MAX_UNCOMMITTED_FILES = 16 * SEARCH_WORKERS;
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

/** A worker failure inside a file scan; never classify it as a file-read warning. */
class ScanWorkerFailure {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

const decodeReply = workerReplyDecoder(SEARCH_RESULT_SCHEMA);
type Rows = SearchResult["lines"];
type Run = (input: SearchInput | LineSearchInput) => Promise<SearchResult>;
/** A listed candidate and its position in the listing. */
interface Queued {
  readonly candidate: Candidate;
  readonly position: number;
}
/** A searched candidate, including fatal failures that only matter before the ordered cutoff. */
type Settled =
  | { readonly file?: GrepFileMatch; readonly warning?: string }
  | { readonly error: unknown };

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
  const rows: Rows = [];
  let lineOffset = 0;
  let nextWanted = 0;
  const check = async (input: SearchInput | LineSearchInput, lines: number) => {
    let result: SearchResult;
    try {
      result = await run(input);
    } catch (error) {
      throw new ScanWorkerFailure(error);
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
    const lines = countLines(source);
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
  const stats = await scanTextFile(filePath, {
    onChunk: async (text, bytesRead) => {
      if (query.multiline) {
        if (bytesRead <= MAX_MULTILINE_SEARCH_BYTES) pending += text;
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
    decoding: "lossy",
  });
  if (stats.hasNul) return undefined;
  if (stats.byteLength > MAX_MULTILINE_SEARCH_BYTES && query.multiline)
    throw new SearchFileLimitError(true);
  await send(pending);
  return {
    rows,
    snapshot: { revision: stats.revision, validUtf8: stats.validUtf8 },
  };
}

/**
 * Search every candidate file in scope. Paths stream from rg in listing order into a queue that
 * at most SEARCH_WORKERS workers drain; a worker starts only when no idle one can take a path.
 * Workers finish in any order, so results commit in listing order: every run returns the same
 * files, rows, and warnings, and a limit keeps the first matches in that order.
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
  /** Committed matches; a file still searching gets at most the remaining room. */
  let matches = 0;
  let matchLimitReached = false;
  let failure: { error: unknown } | undefined;
  const failed = new AbortController();
  const poolSignal = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  const fail = (error: unknown) => {
    failure ??= { error };
    failed.abort();
  };

  const queue: Queued[] = [];
  let listed = false;
  const idle: (() => void)[] = [];
  const space: (() => void)[] = [];
  const stopped = () => failure !== undefined || matchLimitReached;
  const releaseAll = () => {
    for (const wake of idle.splice(0)) wake();
    for (const wake of space.splice(0)) wake();
  };
  const next = async (): Promise<Queued | undefined> => {
    while (!queue.length && !listed && !stopped())
      await new Promise<void>((wake) => idle.push(wake));
    space.shift()?.();
    return stopped() ? undefined : queue.shift();
  };

  /** Searched candidates by listing position, until every earlier one has committed. */
  const settled = new Map<number, Settled>();
  let enqueued = 0;
  let committed = 0;
  const commit = () => {
    for (let result = settled.get(committed); result && !stopped(); ) {
      settled.delete(committed++);
      if ("error" in result) fail(result.error);
      else if (result.warning) warnings.push(result.warning);
      else if (result.file) {
        const rows = result.file.rows.slice(0, limit - matches);
        files.push({ ...result.file, rows });
        matches += rows.length;
        if (matches >= limit) matchLimitReached = true;
      }
      result = settled.get(committed);
    }
    releaseAll();
  };

  const searchPath = async ({ candidate, position }: Queued, run: Run) => {
    const { filePath } = candidate;
    let result: Settled;
    try {
      const found = await searchFile(candidate, query, () => limit - matches, run, poolSignal);
      result = found?.rows.length ? { file: { filePath, ...found } } : {};
    } catch (error) {
      throwIfCancelled(poolSignal);
      const warning =
        error instanceof SearchFileLimitError
          ? `${filePath}: ${error.message}`
          : fileReadWarning(filePath, error, poolSignal);
      result = warning
        ? { warning }
        : { error: error instanceof ScanWorkerFailure ? error.error : error };
    }
    settled.set(position, result);
    commit();
    // Nothing after a fatal candidate can be needed; retire its worker without reusing a failure.
    return !("error" in result);
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
          if (!(await searchPath(file, run))) break;
      },
      { maxOldGenerationSizeMb: MAX_SEARCH_HEAP_MB },
    ).catch((error) => {
      fail(error);
      releaseAll();
    });

  const seen = new Set<string>();
  const enqueue = async (candidate: Candidate) => {
    const { filePath } = candidate;
    if (stopped()) return false;
    if (seen.has(filePath)) return true;
    seen.add(filePath);
    queue.push({ candidate, position: enqueued++ });
    if (idle.length) idle.shift()!();
    else if (workers.length < SEARCH_WORKERS) workers.push(startWorker());
    // A slow early file holds back every later result; bound what waits behind it.
    while (
      (queue.length >= SEARCH_WORKERS || enqueued - committed >= MAX_UNCOMMITTED_FILES) &&
      !stopped()
    )
      await new Promise<void>((wake) => space.push(wake));
    return !stopped();
  };
  let selection: Awaited<ReturnType<typeof listCandidates>>;
  try {
    selection = await listCandidates({
      backend,
      rgPath,
      scope,
      query,
      signal: poolSignal,
      onCandidate: enqueue,
    });
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    listed = true;
    releaseAll();
    await Promise.all(workers);
    throwIfCancelled(signal);
    if (failure) throw failure.error;
  }
  // After every file's warning, so their order does not depend on when the listing ends.
  if (selection.listing) recordSearchDiagnostics(selection.listing, warnings);
  return {
    files,
    matchLimitReached,
    candidates: selection.candidates,
    scanLimitReached: selection.scanLimitReached,
  };
}

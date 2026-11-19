/**
 * Native RegExp matching in a bounded worker pool. grep-candidates supplies absolute paths
 * and optional candidate lines; this module owns queue backpressure, worker cleanup, and
 * each matched file's revision.
 *
 * @module pi-hashline-edit/pi
 */
import { availableParallelism } from "node:os";
import { countLines } from "../core/lines.ts";
import type { GrepQuery, LineSearchInput, SearchInput } from "../core/search.ts";
import { SEARCH_RESULT_SCHEMA, type SearchResult } from "../core/search-schema.ts";
import { scanTextFile } from "./text-stream.ts";
import { searchDiagnostic } from "./rg-process.ts";
import type { SearchScope } from "./grep-scope.ts";
import { listCandidates, type Candidate } from "./grep-candidates.ts";
import { withRegexWorker } from "./regex-worker.ts";
import { workerReplyDecoder } from "./regex-worker-contract.ts";
import { fileReadWarning, throwIfCancelled, type SearchWarning } from "./error-text.ts";
import { formatByteSize } from "./budgets.ts";

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
const MAX_MULTILINE_SEARCH_BYTES = 64 * 1024 * 1024;
/** Line-mode requests end after a line feed once they reach this many UTF-16 units. */
const SEARCH_CHUNK_UNITS = 1024 * 1024;
/** Maximum UTF-16 code units in one physical line; independent of its encoded byte length. */
const MAX_SEARCH_LINE_UNITS = MAX_MULTILINE_SEARCH_BYTES;
const MAX_SEARCH_HEAP_MB = 512;
const MAX_SEARCH_WORKERS = 4;
const SEARCH_WORKERS = Math.max(1, Math.min(MAX_SEARCH_WORKERS, availableParallelism() - 1));
/** Listed files that may wait, searched or not, for an earlier file's result to commit. */
const MAX_UNCOMMITTED_FILES = 16 * SEARCH_WORKERS;

class SearchFileLimitError extends Error {
  constructor(multiline: boolean) {
    super(
      multiline
        ? `Multiline search requires a file of at most ${formatByteSize(MAX_MULTILINE_SEARCH_BYTES)}.`
        : `Search requires lines of at most ${MAX_SEARCH_LINE_UNITS} UTF-16 code units.`,
    );
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
  | { readonly file?: GrepFileMatch; readonly warning?: SearchWarning }
  | { readonly error: unknown };

/**
 * The candidate lines among the next lines of a request source, as the LF view shows them.
 * `next` indexes the first candidate in source; a returned line number is 1-based in source.
 * `lines` holds the lines a worker matches.
 */
function selectLines(source: string, offset: number, wanted: readonly number[], next: number) {
  const numbers: number[] = [];
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
    texts.push(source.slice(start, end), "\n");
  }
  return { numbers, lines: texts.join("") };
}

/**
 * Match one file. Without multiline each line matches alone, so requests split after a
 * line feed; a multiline query sends the whole file. A skipped NUL file can leave a failed worker.
 */
async function searchFile(
  { filePath, lines: wanted }: Candidate,
  query: GrepQuery,
  fileLimit: number,
  run: Run,
  signal: AbortSignal,
): Promise<GrepFileMatch | "restart" | undefined> {
  const rows: Rows = [];
  let lineOffset = 0;
  let nextWanted = 0;
  let evaluationFailure: { error: unknown } | undefined;
  const send = async (source: string) => {
    const lines = countLines(source);
    let candidates = lines;
    if (wanted) {
      let end = nextWanted;
      while (end < wanted.length && wanted[end] <= lineOffset + lines) end++;
      candidates = end - nextWanted;
    }
    const limit = fileLimit - rows.length;
    if (candidates > 0 && limit > 0) {
      // Selecting most lines costs more than matching them all, with the same results.
      const selected =
        wanted && candidates * 2 <= lines
          ? selectLines(source, lineOffset, wanted, nextWanted)
          : undefined;
      const found = await run(
        selected ? { lines: selected.lines, query, limit } : { source, query, limit },
      );
      for (const { lineNumber, column } of found.lines)
        rows.push({
          lineNumber: lineOffset + (selected ? selected.numbers[lineNumber - 1] : lineNumber),
          column,
        });
    }
    if (wanted) nextWanted += candidates;
    lineOffset += lines;
  };

  let pending = "";
  /** Length of pending through its last line feed. */
  let complete = 0;
  let lineUnits = 0;
  /** Past a search limit, which counts only if the rest of the scan finds no NUL. */
  let oversized = false;
  const stats = await scanTextFile(filePath, {
    onChunk: async (text, bytesRead) => {
      // A later NUL makes earlier regex results and failures irrelevant.
      if (oversized || evaluationFailure) return;
      if (query.multiline) {
        oversized = bytesRead > MAX_MULTILINE_SEARCH_BYTES;
        pending = oversized ? "" : pending + text;
        return;
      }
      let start = 0;
      for (;;) {
        const lf = text.indexOf("\n", start);
        const end = lf === -1 ? text.length : lf;
        lineUnits += end - start;
        // One extra CR can belong to the terminator, including across scan chunks.
        if (
          lineUnits > MAX_SEARCH_LINE_UNITS &&
          !(
            lineUnits === MAX_SEARCH_LINE_UNITS + 1 &&
            (end === 0 ? pending.endsWith("\r") : text[end - 1] === "\r")
          )
        ) {
          oversized = true;
          pending = "";
          return;
        }
        if (lf === -1) break;
        lineUnits = 0;
        complete = pending.length + lf + 1;
        start = lf + 1;
      }
      pending += text;
      if (complete >= SEARCH_CHUNK_UNITS) {
        const source = pending.slice(0, complete);
        pending = pending.slice(complete);
        complete = 0;
        try {
          await send(source);
        } catch (error) {
          throwIfCancelled(signal);
          evaluationFailure = { error };
          pending = "";
        }
      }
    },
    signal,
    decoding: "lossy",
  }).catch((error: unknown) => {
    throwIfCancelled(signal);
    // A failed scan cannot clear the earlier worker failure.
    if (evaluationFailure) throw evaluationFailure.error;
    throw error;
  });
  if (stats.hasNul) return evaluationFailure ? "restart" : undefined;
  if (evaluationFailure) throw evaluationFailure.error;
  if (oversized || lineUnits > MAX_SEARCH_LINE_UNITS)
    throw new SearchFileLimitError(query.multiline);
  await send(pending);
  if (!rows.length) return undefined;
  return {
    filePath,
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
  readonly scope: SearchScope;
  readonly query: GrepQuery;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) {
  const { scope, query, limit, timeoutMs, signal } = options;
  const files: GrepFileMatch[] = [];
  /** File warnings in listing order, then the listing's own diagnostic. */
  const warnings: SearchWarning[] = [];
  /** Matches committed in listing order. */
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
  const commit = (position: number, outcome: Settled) => {
    settled.set(position, outcome);
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

  const consume = async (run: Run): Promise<"restart" | void> => {
    for (let item = await next(); item !== undefined; item = await next()) {
      const { candidate, position } = item;
      let found: Awaited<ReturnType<typeof searchFile>>;
      try {
        // Use a fixed file budget so earlier commits cannot change which regex requests run.
        found = await searchFile(candidate, query, limit, run, poolSignal);
      } catch (error) {
        throwIfCancelled(poolSignal);
        const warning =
          error instanceof SearchFileLimitError
            ? { path: candidate.filePath, reason: error.message }
            : fileReadWarning(candidate.filePath, error);
        commit(position, warning ? { warning } : { error });
        if (!warning) return;
        continue;
      }
      if (found === "restart") {
        commit(position, {});
        return found;
      }
      commit(position, { file: found });
    }
  };

  const workers: Promise<void>[] = [];
  const startWorker = async () => {
    try {
      while (!stopped()) {
        const outcome = await withRegexWorker<
          SearchInput | LineSearchInput,
          SearchResult,
          Awaited<ReturnType<typeof consume>>
        >(
          new URL("./grep-worker.mjs", import.meta.url),
          decodeReply,
          timeoutMs,
          poolSignal,
          consume,
          { maxOldGenerationSizeMb: MAX_SEARCH_HEAP_MB },
        );
        if (outcome !== "restart") break;
      }
    } catch (error) {
      fail(error);
      releaseAll();
    }
  };

  const enqueue = async (candidate: Candidate) => {
    if (stopped()) return false;
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
      scope,
      query,
      signal: poolSignal,
      stopped,
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
  const diagnostic = selection.listing && searchDiagnostic(selection.listing);
  if (diagnostic) warnings.push(diagnostic);
  return {
    files,
    warnings,
    matchLimitReached,
    scanLimitReached: selection.scanLimitReached,
  };
}

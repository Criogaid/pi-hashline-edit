/** Complete JS matching over rg's file list; reuse guarded reads and the grep snapshot/output contract. */
import { resolve } from "node:path";
import type { GrepQuery, SearchInput } from "../core/search.ts";
import { SEARCH_RESULT_SCHEMA, type SearchResult } from "../core/search-schema.ts";
import { scanTextFile } from "./text-stream.ts";
import { rawMatchRevision } from "./rg-match-bytes.ts";
import { COMMON_RG_ARGS } from "./rg-process.ts";
import {
  fileReadWarning,
  recordSearchDiagnostics,
  scopeArgs,
  type GrepBackend,
  type RgMatch,
  type SearchFileSnapshot,
  type SearchScope,
} from "./grep-search.ts";
import { withRegexWorker } from "./regex-worker.ts";
import { workerReplyDecoder, invalidWorkerResult } from "./regex-worker-contract.ts";
import { throwIfCancelled } from "./error-text.ts";

/** Bound retained source and worker input; README's JavaScript fallback limits link here. */
export const MAX_JS_SEARCH_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JS_SEARCH_HEAP_MB = 512;
class SearchFileLimitError extends Error {
  constructor() {
    super(
      `JavaScript regex matching requires a file of at most ${MAX_JS_SEARCH_FILE_BYTES / 1024 ** 2} MiB.`,
    );
  }
}
const decodeReply = workerReplyDecoder(SEARCH_RESULT_SCHEMA);

async function readSource(path: string, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  let length = 0;
  const stats = await scanTextFile(
    path,
    undefined,
    signal,
    (chunk) => {
      length += chunk.length;
      if (length <= MAX_JS_SEARCH_FILE_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    },
    "lossy",
  );
  if (stats.hasNul) return undefined;
  if (stats.byteLength > MAX_JS_SEARCH_FILE_BYTES) throw new SearchFileLimitError();
  const bytes = Buffer.concat(chunks);
  const rawMatch = rawMatchRevision(bytes, 1, 0);
  return {
    source: bytes.toString("utf8"),
    rawMatch,
    snapshot: {
      revision: rawMatch.revision,
      validUtf8: stats.validUtf8,
      totalLines: stats.totalLines,
    },
  };
}

export async function searchJavaScript(options: {
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
  const raw: RgMatch[] = [];
  const snapshots = new Map<string, SearchFileSnapshot>();
  let matchLimitReached = false;
  await withRegexWorker<SearchInput, SearchResult, void>(
    new URL("./grep-worker.mjs", import.meta.url),
    decodeReply,
    timeoutMs,
    signal,
    async (run) => {
      const listing = await backend.runRgPaths(
        rgPath,
        [...COMMON_RG_ARGS, ...scopeArgs(scope), "--files", "--null", "--", ...scope.searchPaths],
        signal,
        async (path) => {
          throwIfCancelled(signal);
          const filePath = resolve(path);
          if (snapshots.has(filePath)) return true;
          let input: Awaited<ReturnType<typeof readSource>>;
          try {
            input = await readSource(filePath, signal);
          } catch (error) {
            const warning =
              error instanceof SearchFileLimitError
                ? `${filePath}: ${error.message}`
                : fileReadWarning(filePath, error, signal);
            if (!warning) throw error;
            warnings.push(warning);
            return true;
          }
          if (!input || input.snapshot.totalLines === 0) return true;
          const result = await run({ source: input.source, query, limit: limit - raw.length });
          if (
            result.totalLines !== input.snapshot.totalLines ||
            result.lines.length > limit - raw.length
          )
            throw invalidWorkerResult();
          let previousLine = 0;
          for (const row of result.lines) {
            if (
              row.lineNumber <= previousLine ||
              row.lineNumber > result.totalLines ||
              row.column > input.source.length
            )
              throw invalidWorkerResult();
            previousLine = row.lineNumber;
          }
          if (result.lines.length) snapshots.set(filePath, input.snapshot);
          for (const row of result.lines) raw.push({ ...row, filePath, rawMatch: input.rawMatch });
          matchLimitReached = raw.length >= limit;
          return !matchLimitReached;
        },
      );
      recordSearchDiagnostics(listing, warnings);
    },
    { maxOldGenerationSizeMb: MAX_JS_SEARCH_HEAP_MB },
  );
  return { raw, snapshots, matchLimitReached };
}

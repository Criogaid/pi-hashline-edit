/**
 * Content mode's second read: a matched file's rows come from a new read that must still have the
 * revision the search matched. A file that changed or became unreadable is left out with a warning.
 *
 * @module pi-hashline-edit/pi
 */
import {
  fileReadWarning,
  searchChangedError,
  throwIfCancelled,
  type SearchWarning,
} from "./error-text.ts";
import type { GrepFileMatch } from "./grep-search.ts";
import { scanTextLines } from "./text-stream.ts";

const MAX_CONCURRENT_FILE_READS = 16;

/** Builds one file's output as its lines arrive, so a long line is never retained whole. */
export interface LineCollector<T> {
  onLine(number: number, text: string): void;
  /** Runs only after the read's revision matched the search. */
  finish(): T;
}

type Reread<T> = { readonly value: T } | { readonly warning: SearchWarning };

/** The physical lines shown for a file's matches: each match with `context` lines around it. */
function shownLines(file: GrepFileMatch, context: number): Set<number> {
  const shown = new Set<number>();
  for (const { lineNumber } of file.rows) {
    for (let n = Math.max(1, lineNumber - context); n <= lineNumber + context; n++) shown.add(n);
  }
  return shown;
}

async function rereadFile<T>(
  file: GrepFileMatch,
  context: number,
  collector: LineCollector<T>,
  signal: AbortSignal,
): Promise<T> {
  const shown = shownLines(file, context);
  const stats = await scanTextLines(
    file.filePath,
    (number) => shown.has(number),
    // No maxLineBytes: every selected line keeps its text.
    (line) => collector.onLine(line.number, line.text!),
    { signal, decoding: "lossy" },
  );
  // A NUL the search did not see also changes the revision.
  if (file.snapshot.revision !== stats.revision) throw searchChangedError();
  return collector.finish();
}

/**
 * Read every matched file again, a bounded number at a time, with results in input order. A failure
 * that is not a per-file warning stops the remaining reads and rejects.
 */
export async function rereadMatches<T>(
  files: readonly GrepFileMatch[],
  context: number,
  signal: AbortSignal | undefined,
  collect: (file: GrepFileMatch) => LineCollector<T>,
): Promise<Reread<T>[]> {
  const results = new Array<Reread<T>>(files.length);
  let nextIndex = 0;
  const workerAbort = new AbortController();
  const scanSignal = signal ? AbortSignal.any([signal, workerAbort.signal]) : workerAbort.signal;
  let failure: { error: unknown } | undefined;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_FILE_READS, files.length) },
    async () => {
      try {
        while (!workerAbort.signal.aborted && nextIndex < files.length) {
          const current = nextIndex++;
          const file = files[current];
          try {
            results[current] = {
              value: await rereadFile(file, context, collect(file), scanSignal),
            };
          } catch (error) {
            throwIfCancelled(scanSignal);
            const warning = fileReadWarning(file.filePath, error);
            if (!warning) throw error;
            results[current] = { warning };
          }
        }
      } catch (error) {
        failure ??= { error };
        workerAbort.abort();
      }
    },
  );
  await Promise.all(workers);
  if (failure) throw failure.error;
  return results;
}

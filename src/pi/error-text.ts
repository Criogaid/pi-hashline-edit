import { HashlineError } from "../core/errors.ts";

/**
 * Cancellation, worded like Pi's built-in tools. A mutation record's
 * `publication` and `stage` say where it stopped, so the message does not.
 */
export function cancellationError(cause?: unknown): HashlineError {
  return new HashlineError("OPERATION_ABORTED", "Operation aborted.", { cause });
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError();
}

/**
 * A read observed a concurrent file change; partial bytes must not be classified as source text.
 * The report derives retry advice before publication and inspection advice after publication.
 */
export class FileChangedDuringReadError extends HashlineError {
  constructor(cause?: unknown) {
    super("FILE_CHANGED", "File changed during read.", { cause });
  }
}

/**
 * A searched file no longer matches what ripgrep reported. grep binds matches to
 * one snapshot per file: rg-line-ranges checks line counts, the CRLF text view
 * checks the snapshot copy, and grep-output checks matched text and the
 * revision recorded by grep-search. All of them report this one error.
 */
export function searchChangedError(): HashlineError {
  return new HashlineError("FILE_CHANGED", "File changed during search.");
}

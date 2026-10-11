import { HashlineError } from "../core/errors.ts";

/**
 * Cancellation, worded like Pi's built-in tools. A mutation report's
 * `publication` and `stage` say where it stopped, so the message does not.
 * Whatever a cancelled operation threw is its effect, not a cause.
 */
export function cancellationError(): HashlineError<"OPERATION_ABORTED"> {
  return new HashlineError("OPERATION_ABORTED", "Operation aborted.");
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError();
}

/**
 * A read observed a concurrent file change; partial bytes must not be classified as source text,
 * so whatever the read raised meanwhile is not reported as a cause.
 * Its retry advice holds only before publication; a published mutation's report replaces it.
 */
export class FileChangedDuringReadError extends HashlineError<"FILE_CHANGED"> {
  constructor() {
    super("FILE_CHANGED", "File changed during read.");
  }
}

/**
 * A searched file no longer matches what grep matched. grep binds matches to the
 * revision grep-search hashed while matching, and grep-output re-reads the file
 * against it.
 */
export function searchChangedError(): HashlineError<"FILE_CHANGED"> {
  return new HashlineError("FILE_CHANGED", "File changed during search.");
}

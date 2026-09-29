/** Message text for a caught value; non-Error throws are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every cancellation starts with this text, matching Pi's built-in tools. */
export const OPERATION_ABORTED = "Operation aborted";

/** Cancellation error; `detail` says where it stopped and what state remains. */
export function cancellationError(detail?: string): Error {
  return new Error(detail ? `${OPERATION_ABORTED} ${detail}` : OPERATION_ABORTED);
}

export function throwIfCancelled(signal: AbortSignal | undefined, detail?: string): void {
  if (signal?.aborted) throw cancellationError(detail);
}

/** Rejection from a tool's prepareArguments for a check the schema cannot express. */
export function invalidArgument(path: string, reason: string): Error {
  return new Error(`Invalid argument ${path}: ${reason}`);
}

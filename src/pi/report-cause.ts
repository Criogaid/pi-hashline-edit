/**
 * Cause transport shared by reports and the replacement worker, without Pi runtime imports.
 * External boundaries validate cause data before restoreCause.
 */
import { errnoCode, errorMessage, HashlineError } from "../core/errors.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import type { Cause } from "./report-schema.ts";

class RestoredCause extends Error {
  readonly data: Cause;
  constructor(data: Cause) {
    super(data.message);
    this.data = data;
  }
}

/** Preserve validated cause data across a worker boundary without flattening it into prose. */
export function restoreCause(data: Cause | undefined): Error | undefined {
  return data === undefined ? undefined : new RestoredCause(data);
}

/** One free-text value within its budget, keeping the opening and the final cause. */
export function boundedText(text: string, maxBytes = DEFAULT_OUTPUT_BUDGETS.fieldBytes): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buffer = new DiagnosticBuffer(maxBytes);
  buffer.append(text);
  return buffer.toString();
}

function boundedCause(data: Cause, maxBytes: number): Cause {
  return {
    ...data,
    message: boundedText(data.message, maxBytes),
    ...(data.cause ? { cause: boundedCause(data.cause, maxBytes) } : {}),
    ...(data.errors ? { errors: data.errors.map((inner) => boundedCause(inner, maxBytes)) } : {}),
  };
}

/** Preserve underlying failures; visit each native error once to avoid cycles and repeats. */
export function causeOf(
  error: unknown,
  maxBytes = DEFAULT_OUTPUT_BUDGETS.fieldBytes,
  seen = new Set<unknown>(),
): Cause | undefined {
  if (error === undefined || seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof RestoredCause) return boundedCause(error.data, maxBytes);
  const errno = errnoCode(error);
  const nested = error instanceof Error ? causeOf(error.cause, maxBytes, seen) : undefined;
  const errors =
    error instanceof AggregateError
      ? error.errors.flatMap((inner: unknown) => causeOf(inner, maxBytes, seen) ?? [])
      : [];
  return {
    ...(error instanceof HashlineError ? { error: error.errorCode } : {}),
    ...(errno === undefined ? {} : { code: errno }),
    message: boundedText(errorMessage(error), maxBytes),
    ...(nested ? { cause: nested } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

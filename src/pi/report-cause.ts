/**
 * Cause transport shared by reports and the replacement worker, without Pi runtime imports.
 * The worker loads this module on plain jiti, which lacks the host's typebox
 * mapping, so it must not import typebox at runtime.
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
/** A worker reply error before schema validation; report-cause keeps its transport.
 *
 * Defined here, not in replace-worker-contract.ts, so the worker's runtime graph
 * stays free of typebox: the contract module imports typebox to validate replies,
 * and the worker runs on plain jiti without the host's module mapping.
 */
export interface WorkerError {
  readonly code: string;
  readonly message: string;
  readonly facts?: unknown;
  readonly cause?: Cause;
}
export type WorkerFailure = { readonly error: WorkerError };

/** Transport full failures; the receiving tool applies its model-budget snapshot. */
export function workerFailure(caught: unknown): WorkerFailure {
  if (caught instanceof HashlineError) {
    // Its constructor enforced the code/facts relationship before crossing the boundary.
    return {
      error: {
        code: caught.errorCode,
        message: caught.message,
        ...(caught.facts === undefined ? {} : { facts: caught.facts }),
        ...(caught.cause === undefined ? {} : { cause: causeOf(caught.cause, Infinity) }),
      },
    };
  }
  return {
    error: {
      code: "REGEX_WORKER_FAILED",
      message: "Regex evaluation failed.",
      cause: causeOf(caught, Infinity),
    },
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

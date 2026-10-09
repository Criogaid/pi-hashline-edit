/**
 * The classified error shared by core and the tool layer.
 *
 * Codes, their facts, and their recovery are defined once in
 * src/pi/report-schema.ts; core imports only its types, which are erased at
 * runtime. src/pi/report.ts turns every failure into the one model-facing report.
 */

import type { ErrorCode, ErrorFacts, NextVariant } from "../pi/report-schema.ts";

export type { ErrorCode } from "../pi/report-schema.ts";

/** Options of a failure of `C`: its facts are required exactly when the code has required facts. */
export type HashlineErrorOptions<C extends ErrorCode> = {
  /** The failure beneath this step; reported as structured `cause`, never folded into `message`. */
  readonly cause?: unknown;
  /** One of the code's recovery alternatives; otherwise its default applies. */
  readonly next?: NextVariant<C>;
} & ({} extends ErrorFacts<C>
  ? { readonly facts?: ErrorFacts<C> }
  : { readonly facts: ErrorFacts<C> });

type OptionsArgument<C extends ErrorCode> =
  {} extends HashlineErrorOptions<C>
    ? [options?: HashlineErrorOptions<C>]
    : [options: HashlineErrorOptions<C>];

/**
 * A classified failure. `message` states what the throwing step found, in its
 * own words; the code's schema fixes which facts it carries.
 */
export class HashlineError<C extends ErrorCode = ErrorCode> extends Error {
  readonly errorCode: C;
  readonly facts: ErrorFacts<C> | undefined;
  readonly next: NextVariant<C> | undefined;

  constructor(code: C, message: string, ...[options]: OptionsArgument<C>) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HashlineError";
    this.errorCode = code;
    this.facts = options?.facts;
    this.next = options?.next;
  }
}

/** Messages for text that cannot enter or leave a text mutation; argument issues reuse them as reasons. */
export const TEXT_ERROR_MESSAGES = {
  UNSUPPORTED_ENCODING: "Expected valid UTF-8.",
  UNSUPPORTED_TEXT: "NUL bytes are not editable.",
  INVALID_UNICODE: "Content cannot be encoded losslessly as UTF-8.",
} as const satisfies Partial<Record<ErrorCode, string>>;

/** Message text for a caught value; non-Error throws are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node's errno code of a filesystem error, if any. */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Classify a filesystem error: only ENOENT means a missing path; other errno failures keep their cause. */
export function filesystemErrorCode(
  error: unknown,
): "PATH_NOT_FOUND" | "FILESYSTEM_ERROR" | undefined {
  const code = errnoCode(error);
  if (code === undefined) return undefined;
  return code === "ENOENT" ? "PATH_NOT_FOUND" : "FILESYSTEM_ERROR";
}

/** Classified failures use the pure report schema; the Pi adapter owns transport. */
import type { ErrorCode, ErrorFacts, ErrorOptions, ErrorDescriptor } from "./report-schema.ts";
export { ERROR_CODES, errorDefinitions } from "./report-schema.ts";
export type { ErrorCode, ErrorFacts, ErrorOptions } from "./report-schema.ts";

export class HashlineError<C extends ErrorCode = ErrorCode> extends Error {
  readonly errorCode: C;
  readonly facts: ErrorFacts<C>;
  readonly recovery: ErrorOptions<C>["recovery"];
  constructor(code: C, message: string, options?: ErrorOptions<NoInfer<C>>) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HashlineError";
    this.errorCode = code;
    // Empty schemas deliberately reject facts at construction. The schema is the sole type owner.
    this.facts = (options?.facts ?? {}) as ErrorFacts<C>;
    this.recovery = options?.recovery;
  }
  descriptor(): ErrorDescriptor {
    // Preserve the correlation between the code and its schema-derived facts across an existential instance.
    return {
      code: this.errorCode,
      message: this.message,
      facts: this.facts,
      ...(this.recovery === undefined ? {} : { recovery: this.recovery }),
    } as ErrorDescriptor;
  }
}

/** Messages for text that cannot enter or leave a text mutation. */
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

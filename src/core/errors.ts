/**
 * Error codes and the classified error shared by core and the tool layer.
 * src/pi/tool-error.ts turns every failure into the one model-facing record.
 */

/** Every code of the plugin's error protocol; README "Errors" documents each one. */
export const ERROR_CODES = [
  "INVALID_ARGUMENTS",
  "OPERATION_ABORTED",
  "PATH_NOT_FOUND",
  "FILESYSTEM_ERROR",
  "FILE_CHANGED",
  "UNSUPPORTED_ENCODING",
  "UNSUPPORTED_TEXT",
  "INVALID_UNICODE",
  "ANCHOR_MISMATCH",
  "INVALID_RANGE",
  "OVERLAPPING_EDITS",
  "NO_MATCH",
  "OVERLAPPING_MATCHES",
  "REGEX_TIMEOUT",
  "REGEX_WORKER_FAILED",
  "TARGET_EXISTS",
  "NOT_REGULAR_FILE",
  "MULTIPLE_HARD_LINKS",
  "SYMLINK_UNRESOLVED",
  "PUBLISH_FAILED",
  "POST_PROCESS_FAILED",
  "INVALID_REGEX",
  "SEARCH_INCOMPLETE",
  "RIPGREP_FAILED",
  "UNSUPPORTED_PATH",
  "NOT_FORGETTABLE",
  "UNCLASSIFIED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured facts a record carries beside its message, such as anchor failures or warnings. */
export type ErrorFacts = Readonly<Record<string, unknown>>;

/**
 * A classified failure. `message` states facts only; `next` is the single recovery
 * instruction, when the throw site knows a more specific one than the code's default.
 */
export class HashlineError extends Error {
  readonly errorCode: ErrorCode;
  readonly facts: ErrorFacts;
  readonly next: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { facts?: ErrorFacts; next?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HashlineError";
    this.errorCode = code;
    this.facts = options?.facts ?? {};
    this.next = options?.next;
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

/**
 * The plugin's single error protocol.
 *
 * Pi passes only a thrown error's message to the model, so every tool failure
 * is thrown as one JSON record. Fields, in order: `error` (the code), `tool`,
 * `path` when the call names one, `publication` and `stage` for mutation tools,
 * a fact-only `message`, code-specific facts, and last `next`, the single
 * recovery instruction. Argument errors (argument-error.ts) are records of the
 * same envelope with their own fields.
 *
 * Each fact appears once. Layers add fields instead of sentences: the commit
 * layer owns `publication` and `stage`, Action Fusion adds `then_run`, and a
 * native cause's text (which already names its errno) stays in `message`.
 *
 * Throw sites classify failures as `HashlineError` (core/errors.ts) and may
 * supply a specific `next`. This module owns the default recovery per code,
 * the publication override, filesystem and cancellation classification, the
 * fact-list budget, and the serialization every record shares.
 *
 * @module pi-hashline-edit/pi
 */

import {
  ERROR_CODES,
  errorMessage,
  filesystemErrorCode,
  HashlineError,
  type ErrorCode,
  type ErrorFacts,
} from "../core/errors.ts";
import { MAX_ERROR_TEXT_BYTES } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { cancellationError } from "./error-text.ts";
import { FileMutationError, type MutationStage, type PublicationStatus } from "./file-commit.ts";

/** One serialized tool failure. Code-specific facts follow `message`; `next` comes last. */
export interface ErrorRecord {
  readonly error: ErrorCode;
  readonly tool: string;
  readonly path?: string | readonly string[];
  readonly publication?: PublicationStatus;
  readonly stage?: MutationStage;
  readonly message?: string;
  readonly next?: string;
  readonly [fact: string]: unknown;
}

/** Recovery per code, unless the throw site supplies a more specific one. */
const NEXT: Partial<Record<ErrorCode, string>> = {
  PATH_NOT_FOUND: "Check the path.",
  FILE_CHANGED: "Retry the call.",
  ANCHOR_MISMATCH:
    "Before reusing a candidate or observed anchor, confirm it is the intended target; use read or grep for omitted rows, out-of-range lines, or more context. Retries verify every anchor again.",
  OVERLAPPING_EDITS: "Merge overlapping edits into one edit per range.",
  NO_MATCH:
    "Verify the target text with read or grep; check case sensitivity or regex flags if applicable.",
};

/** Once a mutation may have reached the file, a retry could apply it twice. */
const PUBLICATION_NEXT: Record<Exclude<PublicationStatus, "NOT_PUBLISHED">, string> = {
  PUBLISHED: "The change is saved; do not repeat it. Read the file before further edits.",
  UNKNOWN: "The change may already be applied; read the file before retrying.",
};

export interface ErrorContext {
  /** The path or paths the call names, as supplied. */
  readonly path?: string | readonly string[];
  /** Mutation tools report `publication` and `stage` on every record. */
  readonly mutation?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Adds facts a caller knows about a failure, such as `then_run`, without
 * changing its classification. Facts from outer annotations come last.
 */
export class AnnotatedError extends Error {
  readonly error: unknown;
  readonly facts: ErrorFacts;

  constructor(error: unknown, facts: ErrorFacts) {
    super(errorMessage(error), { cause: error });
    this.name = "AnnotatedError";
    this.error = error;
    this.facts = facts;
  }
}

/** The failure an annotation wraps, for callers that inspect publication or stage. */
export function unannotated(error: unknown): unknown {
  while (error instanceof AnnotatedError) error = error.error;
  return error;
}

function classify(error: unknown, signal: AbortSignal | undefined): HashlineError {
  if (error instanceof HashlineError) return error;
  // Pi's native tools and Node report cancellation with their own errors.
  if (signal?.aborted) return cancellationError(error);
  const code = filesystemErrorCode(error) ?? "UNCLASSIFIED";
  return new HashlineError(code, errorMessage(error), { cause: error });
}

function boundedText(text: string): string {
  const buffer = new DiagnosticBuffer(MAX_ERROR_TEXT_BYTES);
  buffer.append(text);
  return buffer.toString();
}

/** Classify a caught failure as the record the model receives. */
export function describeError(tool: string, caught: unknown, context: ErrorContext): ErrorRecord {
  const annotations: ErrorFacts[] = [];
  let error = caught;
  while (error instanceof AnnotatedError) {
    annotations.unshift(error.facts);
    error = error.error;
  }
  const failure = classify(error, context.signal);
  const publication =
    failure instanceof FileMutationError ? failure.publication : ("NOT_PUBLISHED" as const);
  const stage = failure instanceof FileMutationError ? failure.stage : ("prepare" as const);
  const next =
    context.mutation && publication !== "NOT_PUBLISHED"
      ? PUBLICATION_NEXT[publication]
      : (failure.next ?? NEXT[failure.errorCode]);
  return {
    error: failure.errorCode,
    tool,
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.mutation ? { publication, stage } : {}),
    message: boundedText(failure.message),
    ...failure.facts,
    ...Object.assign({}, ...annotations),
    ...(next === undefined ? {} : { next }),
  };
}

/** Every record, including argument errors, uses this one serialization. */
export function encodeErrorRecord(record: object): string {
  return JSON.stringify(record, null, 2);
}

/** Pi transports only the message: it is the serialized record; the original stays as cause. */
export class ReportedToolError extends Error {
  readonly record: ErrorRecord;

  constructor(record: ErrorRecord, cause: unknown) {
    super(encodeErrorRecord(record), { cause });
    this.name = "ReportedToolError";
    this.record = record;
  }
}

/** Run one tool execution, reporting any failure as its error record. */
export async function reportToolErrors<T>(
  tool: string,
  context: ErrorContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ReportedToolError(describeError(tool, error, context), error);
  }
}

/** Recognize a serialized record; other text is not one of ours. */
export function parseErrorRecord(text: string): ErrorRecord | undefined {
  if (!text.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("error" in value) ||
    !(ERROR_CODES as readonly unknown[]).includes(value.error) ||
    !("tool" in value) ||
    typeof value.tool !== "string"
  )
    return undefined;
  return value as ErrorRecord;
}

/**
 * Keep the leading entries of a fact list whose compact JSON fits `maxBytes`;
 * report how many were omitted. Whole entries are omitted, never cut.
 */
export function boundedFacts<T>(
  entries: readonly T[],
  maxBytes: number,
): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + entryBytes > maxBytes) break;
    kept.push(entry);
    bytes += entryBytes;
  }
  return { kept, omitted: entries.length - kept.length };
}

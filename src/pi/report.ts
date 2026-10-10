/**
 * The plugin's single result protocol.
 *
 * Every result of every tool states its facts in one report (report-schema.ts).
 * Layers return structured facts and never append sentences: the commit layer
 * owns publication, stage, and freshness; each tool owns its outcome facts;
 * Action Fusion owns `then_run`; forget owns ids. This module builds the
 * report of a success or a failure, derives its single `next`, and owns the
 * one model-facing serialization: the report as one JSON object, fields in
 * schema order. A success puts it after the tool's content payload; a failure
 * is the report alone, returned with `isError` so that `details.report` reaches
 * the TUI, which renders the same object (render.ts).
 *
 * Throw sites classify failures as `HashlineError` (core/errors.ts); a failure
 * beneath the failing step becomes structured `cause`, never part of `message`.
 *
 * @module pi-hashline-edit/pi
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { errorMessage, errnoCode, filesystemErrorCode, HashlineError } from "../core/errors.ts";
import { boundedText, causeOf } from "./report-cause.ts";
import { DEFAULT_OUTPUT_BUDGETS, type OutputBudgets } from "./budgets.ts";
export { boundedText, causeOf } from "./report-cause.ts";
import { cancellationError } from "./error-text.ts";
import { FileMutationError } from "./file-commit.ts";
import {
  ERROR_DEFINITIONS,
  OUTCOME_NEXT,
  PUBLICATION_NEXT,
  REPORT_SCHEMA,
  WIRE_REPORT_SCHEMA,
  type Cause,
  type CommandStatus,
  type ErrorCode,
  type Report,
} from "./report-schema.ts";

export type { Report } from "./report-schema.ts";

/** Every result's details carry its report for the TUI; Pi does not send details to the model. */
export interface ReportDetails {
  readonly report: Report;
}

type Content = AgentToolResult<unknown>["content"];

/** The fields a report states, in schema order; both renderers list them in this order. */
export function reportEntries(report: Report): [string, unknown][] {
  return Object.keys(REPORT_SCHEMA.properties).flatMap((key) => {
    const value = (report as Record<string, unknown>)[key];
    return value === undefined ? [] : [[key, value] as [string, unknown]];
  });
}

/** Serialize a report: one JSON object, fields in schema order. The only model-facing form. */
export function renderReport(report: Report): string {
  return JSON.stringify(Object.fromEntries(reportEntries(report)), null, 2);
}

/** Decode the current report format for Pi's text-only argument failures and forget tags. */
export function decodeReport(text: string): Report | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Value.Check(WIRE_REPORT_SCHEMA, value) ? (value as Report) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError)
      return undefined;
    throw error;
  }
}

/** Tool results carry their report in details; Pi argument failures carry it as their final text block. */
export function reportOf(result: {
  readonly content?: Content;
  readonly details?: unknown;
}): Report | undefined {
  const details = result.details as Partial<ReportDetails> | undefined;
  if (details?.report) return details.report;
  const last = result.content?.at(-1);
  return last?.type === "text" ? decodeReport(last.text) : undefined;
}

const ENVELOPE = new Set(["tool", "path"]);

/** The recovery a successful result's facts call for: the first in OUTCOME_NEXT order. */
function outcomeNext(report: Report): string | undefined {
  return OUTCOME_NEXT.find(([fact]) => report[fact] !== undefined)?.[1];
}

/**
 * A successful result: the tool's payload, then its report when it states
 * anything beyond tool and path or when there is no payload.
 */
export function reportResult<TDetails extends object | undefined>(
  report: Report,
  payload: Content = [],
  details?: TDetails,
): AgentToolResult<TDetails & ReportDetails> {
  const complete = Object.fromEntries(
    reportEntries({ ...report, next: outcomeNext(report) }),
  ) as Report;
  const stated = Object.entries(complete).some(
    ([key, value]) => value !== undefined && !ENVELOPE.has(key),
  );
  return {
    content:
      stated || payload.length === 0
        ? [...payload, { type: "text", text: renderReport(complete) }]
        : payload,
    details: { ...details, report: complete } as TDetails & ReportDetails,
  };
}

/** A failed result: the report is its entire content, flagged so Pi reports it as an error. */
export function failureResult(report: Report): AgentToolResult<ReportDetails> {
  const complete = Object.fromEntries(reportEntries(report)) as Report;
  return {
    content: [{ type: "text", text: renderReport(complete) }],
    details: { report: complete },
    isError: true,
  };
}

/** Where a failure happened, as the caller knows it. */
export interface FailureContext {
  /** The path or paths the call names, as supplied. */
  readonly path?: string | readonly string[];
  /** Mutation tools report `publication` and `stage` on every failure. */
  readonly mutation?: boolean;
  readonly signal?: AbortSignal;
  readonly budget?: OutputBudgets;
}

/**
 * A mutation that did not complete, so its then_run command never ran. Action
 * Fusion owns the command status; the mutation's own failure stays unchanged.
 */
export class CommandNotRun extends Error {
  readonly error: unknown;
  readonly status: Extract<CommandStatus, "skipped" | "cancelled">;
  readonly progressError: Cause | undefined;

  constructor(
    error: unknown,
    status: Extract<CommandStatus, "skipped" | "cancelled">,
    progressError?: Cause,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = "CommandNotRun";
    this.error = error;
    this.status = status;
    this.progressError = progressError;
  }
}

function classify(error: unknown, signal: AbortSignal | undefined): HashlineError {
  if (error instanceof HashlineError) return error;
  // Pi's native tools and Node report cancellation with their own errors.
  if (signal?.aborted) return cancellationError();
  const code: ErrorCode = filesystemErrorCode(error) ?? "UNCLASSIFIED";
  const diagnostic = errorMessage(error);
  const errno = errnoCode(error);
  const message = errno && !diagnostic.includes(errno) ? `${errno}: ${diagnostic}` : diagnostic;
  return new HashlineError(code, message, {
    cause: error instanceof Error ? error.cause : undefined,
  });
}

/** The recovery of a failure: publication first, then the throw site's alternative or the code's default. */
function failureNext(
  failure: HashlineError,
  publication: Report["publication"],
): string | undefined {
  if (publication === "PUBLISHED" || publication === "UNKNOWN")
    return PUBLICATION_NEXT[publication];
  const next = (ERROR_DEFINITIONS[failure.errorCode] as { next?: Record<string, string> }).next;
  return next?.[(failure.next as string | undefined) ?? "default"];
}

/** Classify a caught failure as the report the model receives. */
export function describeFailure(tool: string, caught: unknown, context: FailureContext): Report {
  let error = caught;
  let command: CommandNotRun | undefined;
  if (error instanceof CommandNotRun) {
    command = error;
    error = error.error;
  }
  const failure = classify(error, context.signal);
  const budget = context.budget ?? DEFAULT_OUTPUT_BUDGETS;
  const publication = context.mutation
    ? failure instanceof FileMutationError
      ? failure.publication
      : ("NOT_PUBLISHED" as const)
    : undefined;
  const stage = context.mutation
    ? failure instanceof FileMutationError
      ? failure.stage
      : ("prepare" as const)
    : undefined;
  return {
    error: failure.errorCode,
    tool,
    path: context.path as Report["path"],
    publication,
    stage,
    message: boundedText(failure.message, budget.fieldBytes),
    cause: causeOf(failure.cause, budget.fieldBytes),
    ...failure.facts,
    then_run: command ? { status: command.status } : undefined,
    progressError: command?.progressError,
    next: failureNext(failure, publication),
  };
}

/** Run one tool execution, returning any failure as its report. */
export async function runTool<T>(
  tool: string,
  context: FailureContext,
  run: () => Promise<T>,
): Promise<T | AgentToolResult<ReportDetails>> {
  try {
    return await run();
  } catch (error) {
    return failureResult(describeFailure(tool, error, context));
  }
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

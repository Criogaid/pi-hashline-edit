/**
 * The plugin's single result protocol.
 *
 * Every result of every tool states its facts in one report (report-schema.ts).
 * Layers return structured facts and never append sentences: the commit layer
 * owns publication, stage, and freshness; each tool owns its outcome facts;
 * Action Fusion owns `then_run`. This module builds the
 * report of a success or a failure, derives its single `next`, and owns the
 * one model-facing serialization: one JSON object in schema order, with tool
 * and path omitted on success. A success puts it after the content payload;
 * a failure is the report alone. The TUI receives the full report in details.
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
  type FailureReport,
  type Report,
  type ReportTool,
  type SuccessReport,
} from "./report-schema.ts";

export type { Report } from "./report-schema.ts";

/** Every result's details carry its report for the TUI; Pi does not send details to the model. */
export interface ReportDetails<TReport extends Report = Report> {
  readonly report: TReport;
}

type Content = AgentToolResult<unknown>["content"];

/** The fields a report states, in schema order; both renderers list them in this order. */
export function reportEntries(report: Report): [string, unknown][] {
  return Object.keys(REPORT_SCHEMA.properties).flatMap((key) => {
    const value = (report as Record<string, unknown>)[key];
    return value === undefined ? [] : [[key, value] as [string, unknown]];
  });
}

/** Serialize facts in schema order; successful results do not repeat their call's tool and path. */
export function renderReport(report: Report): string {
  const entries = reportEntries(report).filter(
    ([key]) => report.error !== undefined || !ENVELOPE.has(key),
  );
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

/** Decode a text report; success text omits its tool, which the originating call supplies. */
export function decodeReport(text: string, contextTool?: string): Report | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    let value: unknown = JSON.parse(text);
    if (
      contextTool !== undefined &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !("tool" in value) &&
      !("error" in value)
    ) {
      value = { tool: contextTool, ...value };
    }
    return Value.Check(WIRE_REPORT_SCHEMA, value) ? (value as Report) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError)
      return undefined;
    throw error;
  }
}

/**
 * The report a result's details carry, checked once against the wire schema: details also
 * come from saved sessions and other extensions' result hooks, so their shape is unknown.
 */
export function detailsReport(details: unknown): Report | undefined {
  const report: unknown =
    typeof details === "object" && details !== null ? Reflect.get(details, "report") : undefined;
  return report !== undefined && Value.Check(WIRE_REPORT_SCHEMA, report)
    ? (report as Report)
    : undefined;
}

/** Tool results carry their report in details; Pi argument failures carry it as their final text block. */
export function reportOf(result: {
  readonly content?: Content;
  readonly details?: unknown;
  readonly toolName?: string;
  readonly isError?: boolean;
}): Report | undefined {
  const report = detailsReport(result.details);
  if (report) return report;
  const last = result.content?.at(-1);
  return last?.type === "text"
    ? decodeReport(last.text, result.isError ? undefined : result.toolName)
    : undefined;
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
  report: SuccessReport,
  payload: Content = [],
  details?: TDetails,
): AgentToolResult<TDetails & ReportDetails<SuccessReport>> {
  const complete = Object.fromEntries(
    reportEntries({ ...report, next: outcomeNext(report) }),
  ) as SuccessReport;
  const stated = Object.entries(complete).some(
    ([key, value]) => value !== undefined && !ENVELOPE.has(key),
  );
  return {
    content:
      stated || payload.length === 0
        ? [...payload, { type: "text", text: renderReport(complete) }]
        : payload,
    details: { ...details, report: complete } as TDetails & ReportDetails<SuccessReport>,
  };
}

/** A failed result: the report is its entire content, flagged so Pi reports it as an error. */
export function failureResult(
  report: FailureReport,
): AgentToolResult<ReportDetails<FailureReport>> {
  const complete = Object.fromEntries(reportEntries(report)) as FailureReport;
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
 * It lives here because describeFailure unwraps it, and action-fusion.ts already
 * imports this module.
 */
export class CommandNotRun extends Error {
  readonly status: Extract<CommandStatus, "skipped" | "cancelled">;
  readonly progressError: Cause | undefined;

  constructor(
    error: unknown,
    status: Extract<CommandStatus, "skipped" | "cancelled">,
    progressError?: Cause,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = "CommandNotRun";
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
export function describeFailure(
  tool: ReportTool,
  caught: unknown,
  context: FailureContext,
): FailureReport {
  let error = caught;
  let command: CommandNotRun | undefined;
  if (error instanceof CommandNotRun) {
    command = error;
    // The mutation's own failure, unchanged.
    error = error.cause;
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
  // HashlineError's constructor ties its facts to its code; the union cannot carry that link.
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
  } as FailureReport;
}

/** Run one tool execution, returning any failure as its report. */
export async function runTool<T>(
  tool: ReportTool,
  context: FailureContext,
  run: () => Promise<T>,
): Promise<T | AgentToolResult<ReportDetails<FailureReport>>> {
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

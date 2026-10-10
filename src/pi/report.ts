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
import type { TSchema } from "typebox";
import { errnoCode, errorMessage, filesystemErrorCode, HashlineError } from "../core/errors.ts";
import {
  MAX_CAUSE_BYTES,
  MAX_CAUSE_DEPTH,
  MAX_CAUSE_NODES,
  MAX_ERROR_TEXT_BYTES,
} from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { cancellationError } from "./error-text.ts";
import { FileMutationError } from "./file-commit.ts";
import {
  ERROR_DEFINITIONS,
  OUTCOME_NEXT,
  PUBLICATION_NEXT,
  REPORT_SCHEMA,
  LEGACY_REPORT_SCHEMA,
  WIRE_REPORT_SCHEMA,
  REPORT_VERSION,
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

/** One free-text value within its budget, keeping the opening and the final cause. */
export function boundedText(text: string): string {
  const buffer = new DiagnosticBuffer(MAX_ERROR_TEXT_BYTES);
  buffer.append(text);
  return buffer.toString();
}

/** Bound the complete graph; `omitted` counts unexpanded references rather than unseen descendants. */
export function causeOf(error: unknown): Cause | undefined {
  const seen = new Set<unknown>();
  const omissionReserveBytes = 64;
  let remainingBytes = MAX_CAUSE_BYTES - omissionReserveBytes;
  let visited = 0;
  let omitted = 0;
  const visit = (value: unknown, depth: number): Cause | undefined => {
    if (value === undefined) return undefined;
    if (depth > MAX_CAUSE_DEPTH || visited >= MAX_CAUSE_NODES) {
      omitted++;
      return undefined;
    }
    visited++;
    if (seen.has(value)) {
      omitted++;
      return undefined;
    }
    seen.add(value);
    const errno = errnoCode(value);
    const node: Cause = {
      ...(value instanceof HashlineError ? { error: value.errorCode } : {}),
      ...(errno === undefined ? {} : { code: errno }),
      message: boundedText(errorMessage(value)),
    };
    const chargeBytes = () => {
      const own = JSON.stringify(node, null, 2);
      // Charge nesting indentation and child containers before descending.
      return Buffer.byteLength(own) + own.split("\n").length * (depth * 4 + 4) + 32;
    };
    let nodeBytes = chargeBytes();
    let messageBudgetBytes = MAX_ERROR_TEXT_BYTES;
    // JSON escaping can exceed the raw text limit; retain the root's opening and final cause.
    while (depth === 1 && nodeBytes > remainingBytes && messageBudgetBytes > 1) {
      messageBudgetBytes = Math.floor(messageBudgetBytes / 2);
      const buffer = new DiagnosticBuffer(messageBudgetBytes);
      buffer.append(errorMessage(value));
      node.message = buffer.toString();
      nodeBytes = chargeBytes();
    }
    if (nodeBytes > remainingBytes) {
      omitted++;
      return undefined;
    }
    remainingBytes -= nodeBytes;
    if (value instanceof Error) {
      const child = visit(value.cause, depth + 1);
      if (child) node.cause = child;
    }
    if (value instanceof AggregateError) {
      const children: Cause[] = [];
      for (let index = 0; index < value.errors.length; index++) {
        if (visited >= MAX_CAUSE_NODES || remainingBytes <= omissionReserveBytes) {
          omitted += value.errors.length - index;
          break;
        }
        const child = visit(value.errors[index], depth + 1);
        if (child) children.push(child);
      }
      if (children.length) node.errors = children;
    }
    return node;
  };
  const root = visit(error, 1);
  if (root && omitted) root.omitted = omitted;
  return root;
}

/** The fields a report states, in schema order; both renderers list them in this order. */
export function reportEntries(report: Report): [string, unknown][] {
  return Object.keys(REPORT_SCHEMA.properties).flatMap((key) => {
    const value = (report as Record<string, unknown>)[key];
    return value === undefined ? [] : [[key, value] as [string, unknown]];
  });
}

/** Serialize a report: one JSON object, fields in schema order. The only model-facing form. */
export function renderReport(report: Report): string {
  return JSON.stringify(
    { $hashline: REPORT_VERSION, ...Object.fromEntries(reportEntries(report)) },
    null,
    2,
  );
}

/** Reject oversized cause data before TypeBox's recursive traversal of an external JSON value. */
function boundedCauseData(value: unknown): boolean {
  if (value === undefined) return true;
  const pending = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending[pending.length - 1];
    pending.length--;
    if (++nodes > MAX_CAUSE_NODES || current.depth > MAX_CAUSE_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null || Array.isArray(current.value))
      return false;
    const child: unknown = Reflect.get(current.value, "cause");
    if (child !== undefined) pending.push({ value: child, depth: current.depth + 1 });
    const children: unknown = Reflect.get(current.value, "errors");
    if (children !== undefined) {
      if (!Array.isArray(children) || nodes + pending.length + children.length > MAX_CAUSE_NODES)
        return false;
      for (const value of children) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(value, null, 2)) <= MAX_CAUSE_BYTES;
}

/** The final-result boundary also accepts structured metadata modified by tool_result hooks. */
function checkReportData(schema: TSchema, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    if (
      !["cause", "freshnessError", "progressError"].every((key) =>
        boundedCauseData(Reflect.get(value, key)),
      )
    )
      return false;
    return Value.Check(schema, value);
  } catch (error) {
    // Unsupported JSON depth or non-serializable hook metadata retains the final raw content.
    if (error instanceof RangeError || error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Recognize a serialized report where no structured copy exists: argument
 * rejections, which Pi raises before execution and transports as text only,
 * and the model-visible content forget edits. Other text is not ours.
 */
export function decodeReport(text: string): Report | undefined {
  if (!text.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  // Dynamic schema arrays validate at runtime; WireReport retains the mapped code types.
  if (checkReportData(WIRE_REPORT_SCHEMA, value)) {
    const { $hashline: _version, ...report } = value as import("./report-schema.ts").WireReport;
    return report;
  }
  if (!checkReportData(LEGACY_REPORT_SCHEMA, value) || typeof value !== "object" || value === null)
    return undefined;
  // Legacy identity is limited to actual failures and saved forget tags.
  return "error" in value || "resultId" in value ? (value as Report) : undefined;
}

/** One identifiable block in final content; hook replacements and ambiguous copies retain raw text. */
export function reportBlock(result: {
  readonly content?: Content;
  readonly details?: unknown;
}): { index: number; report: Report } | undefined {
  const details = result.details as Partial<ReportDetails> | undefined;
  const live = details?.report;
  if (live !== undefined && !checkReportData(LEGACY_REPORT_SCHEMA, live)) return undefined;
  let expected: string | undefined;
  if (live) {
    try {
      expected = renderReport(live);
    } catch (error) {
      // Hooks may replace details with non-JSON data; keep their final content unchanged.
      if (error instanceof TypeError || error instanceof RangeError) return undefined;
      throw error;
    }
  }
  const candidates = (result.content ?? []).flatMap((block, index) => {
    if (block.type !== "text") return [];
    if (live) return block.text === expected ? [{ index, report: live }] : [];
    const report = decodeReport(block.text);
    return report ? [{ index, report }] : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The report belonging to the final content, independent of registration or object identity. */
export function reportOf(result: {
  readonly content?: Content;
  readonly details?: unknown;
}): Report | undefined {
  return reportBlock(result)?.report;
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
  // The native layer threw: its message describes its own step.
  const code: ErrorCode = filesystemErrorCode(error) ?? "UNCLASSIFIED";
  return new HashlineError(code, errorMessage(error), {
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
    message: boundedText(failure.message),
    cause: causeOf(failure.cause),
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

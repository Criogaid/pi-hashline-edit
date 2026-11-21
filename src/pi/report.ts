/**
 * The plugin's single result protocol.
 *
 * Every result of every tool states its facts in one report (report-schema.ts).
 * Layers return structured facts and never append sentences: the commit layer
 * owns publication and freshness; each tool owns its outcome facts;
 * Action Fusion owns `then_run`. This module builds the
 * report of a success or a failure, derives its single `next`, and owns the
 * one model-facing serialization: one JSON object in schema order, without the
 * call's own tool and path. A success puts it after the content payload;
 * a failure is the report alone. The TUI receives the full report in details.
 * Scripts receive a success as one object with the same fields, and the facts
 * the text omits because the payload or the call already shows them; a failure
 * carries none, so their call rejects with the report text.
 *
 * Throw sites classify failures as `HashlineError` (core/errors.ts); a failure
 * beneath the failing step becomes structured `cause`, never part of `message`.
 *
 * @module pi-hashline-edit/pi
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import {
  errorMessage,
  errnoCode,
  filesystemErrorCode,
  HashlineError,
  pathError,
} from "../core/errors.ts";
import { boundedText, causeOf } from "./report-cause.ts";
import { leadingEntriesWithin, type OutputBudgets } from "./budgets.ts";
import { cancellationError } from "./error-text.ts";
import { serializeAbsolutePath } from "./path.ts";
import {
  BOUNDED_LISTS,
  ERROR_DEFINITIONS,
  MODEL_OMITTED_FIELDS,
  OUTCOME_NEXT,
  PUBLICATION_NEXT,
  REPORT_SCHEMA,
  SCRIPT_OUTPUT_SCHEMAS,
  WIRE_REPORT_SCHEMA,
  type ErrorCode,
  type FailureReport,
  type OutcomeVariant,
  type ModelOmittedField,
  type MutationToolName,
  type Report,
  type ReportTool,
  type SuccessFacts,
  type SuccessReport,
} from "./report-schema.ts";

/** Every result's details carry its report for the TUI; Pi does not send details to the model. */
export interface ReportDetails<TReport extends Report = Report> {
  readonly report: TReport;
}

type Content = AgentToolResult<unknown>["content"];

/** What a report's text states: the originating call supplies its tool and path. */
export type ReportText<R extends Report = Report> = R extends unknown
  ? Omit<R, ModelOmittedField>
  : never;

/** The fields a report states, in schema order; both renderers list them in this order. */
export function reportEntries(report: ReportText): [string, unknown][] {
  return Object.keys(REPORT_SCHEMA.properties).flatMap((key) => {
    const value = (report as Record<string, unknown>)[key];
    return value === undefined ? [] : [[key, value] as [string, unknown]];
  });
}

/** The fields a report's text states, in schema order: a result never repeats its call's tool and path. */
function statedFields(report: ReportText): Record<string, unknown> {
  return Object.fromEntries(
    reportEntries(report).filter(([key]) => !MODEL_OMITTED_FIELDS.has(key as ModelOmittedField)),
  );
}

/** Serialize the stated fields as the one JSON object a result's text carries. */
export function renderReport(report: ReportText): string {
  return JSON.stringify(statedFields(report), null, 2);
}

/** Decode a text report; the text omits its tool, which the originating call supplies. */
function decodeReport(text: string, contextTool: ReportTool): Report | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    let value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if ("tool" in value) {
        if (value.tool !== contextTool) return undefined;
      } else {
        value = { tool: contextTool, ...value };
      }
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
export function detailsReport(details: unknown, contextTool: ReportTool): Report | undefined {
  const report: unknown =
    typeof details === "object" && details !== null ? Reflect.get(details, "report") : undefined;
  try {
    // Hooks can introduce cycles; reject non-JSON reports before recursive schema validation.
    JSON.stringify(report);
    if (report === undefined || !Value.Check(WIRE_REPORT_SCHEMA, report)) return undefined;
    const checked = report as Report;
    return checked.tool === contextTool ? checked : undefined;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/** Tool results carry their report in details; Pi argument failures carry it as their final text block. */
export function reportOf(
  result: { readonly content: Content; readonly details?: unknown },
  tool: ReportTool,
): Report | undefined {
  const report = detailsReport(result.details, tool);
  if (report) return report;
  const last = result.content.at(-1);
  return last?.type === "text" ? decodeReport(last.text, tool) : undefined;
}

/**
 * The recovery a successful result's facts call for: the rule of the first fact present in
 * OUTCOME_NEXT order, in the producer's selected alternative when that rule names it. The value
 * the rule excepts calls for none, and no later rule applies.
 */
function outcomeNext(report: Report, variant: OutcomeVariant | undefined): string | undefined {
  const rule = OUTCOME_NEXT.find(([fact]) => report[fact] !== undefined);
  if (!rule || report[rule[0]] === rule[2]) return undefined;
  const next = rule[1];
  return typeof next === "object" ? ((variant && next[variant]) ?? next.default) : next;
}

/**
 * The facts every report states as producers gave them, made fit for output: resolved paths
 * spelled as headers spell paths, then each bounded list cut to whole entries within the
 * diagnostic block, counting what it omits.
 */
function boundFacts<R extends Partial<Report>>(report: R, budget: OutputBudgets): R {
  const bounded: Record<string, unknown> = report.missing
    ? { ...report, missing: report.missing.map(serializeAbsolutePath) }
    : { ...report };
  for (const [list, omittedField] of BOUNDED_LISTS) {
    const entries = bounded[list] as readonly unknown[] | undefined;
    if (!entries) continue;
    const kept = leadingEntriesWithin(entries, budget.blockBytes);
    if (kept.length === entries.length) continue;
    bounded[list] = kept;
    bounded[omittedField] = entries.length - kept.length;
  }
  return bounded as R;
}

/**
 * Facts a producer hands to scripts only, because the payload or the call already shows them to
 * the model: its tool's own facts, and a mutation's command outcome with the output that the
 * payload shows.
 */
type ImpliedFacts<TTool extends ReportTool> = Partial<SuccessFacts<TTool>> &
  (TTool extends MutationToolName ? Pick<Report, "then_run"> : unknown);

/**
 * A successful result: the tool's payload, then its report when it states
 * anything beyond tool and path or when there is no payload. `variant` is the recovery
 * alternative the producing layer selected. Scripts receive one object
 * (`SCRIPT_OUTPUT_SCHEMAS`): the payload's text as `text` for `read` and `grep`, then the
 * stated fields and `implied`. The text, its `next`, and the details leave `implied` out.
 */
export function reportResult<
  TDetails extends object | undefined,
  TTool extends ReportTool = ReportTool,
>(
  report: SuccessReport & { tool: TTool },
  payload: Content,
  budget: OutputBudgets,
  {
    details,
    variant,
    implied,
  }: {
    readonly details?: TDetails;
    readonly variant?: OutcomeVariant;
    readonly implied?: ImpliedFacts<TTool>;
  } = {},
): AgentToolResult<TDetails & ReportDetails<SuccessReport>> {
  const complete = Object.fromEntries(
    reportEntries({ ...boundFacts(report, budget), next: outcomeNext(report, variant) }),
  ) as SuccessReport;
  const stated = Object.keys(statedFields(complete)).length > 0;
  const text = payload.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return {
    content:
      stated || payload.length === 0
        ? [...payload, { type: "text", text: renderReport(complete) }]
        : payload,
    details: { ...details, report: complete } as TDetails & ReportDetails<SuccessReport>,
    // Report fields are JSON values: the wire schema admits nothing else.
    structuredContent: {
      ...("text" in SCRIPT_OUTPUT_SCHEMAS[report.tool].properties ? { text } : {}),
      ...statedFields({ ...complete, ...implied }),
    } as NonNullable<AgentToolResult<unknown>["structuredContent"]>,
  };
}

/** A failed result: the report is its entire content, flagged so Pi reports it as an error. */
function failureResult(report: FailureReport): AgentToolResult<ReportDetails<FailureReport>> {
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
  readonly signal: AbortSignal;
  readonly budget: OutputBudgets;
}

/** What a mutation tool states about its failure beside the classified error. */
type MutationFailureFacts = Pick<FailureReport, "publication" | "then_run" | "progressError">;

function classify(error: unknown, signal: AbortSignal): HashlineError {
  if (error instanceof HashlineError) return error;
  // Pi's native tools and Node report cancellation with their own errors.
  if (signal.aborted) return cancellationError();
  const path = pathError(error);
  if (path) return path;
  const code: ErrorCode = filesystemErrorCode(error) ?? "UNCLASSIFIED";
  const cause = error instanceof Error ? error.cause : undefined;
  const diagnostic = errorMessage(error);
  const errno = errnoCode(error);
  const message = errno && !diagnostic.includes(errno) ? `${errno}: ${diagnostic}` : diagnostic;
  return new HashlineError(code, message, { cause });
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
  mutation?: MutationFailureFacts,
): FailureReport {
  const failure = classify(caught, context.signal);
  const budget = context.budget;
  // HashlineError's constructor ties its facts to its code; the union cannot carry that link.
  return boundFacts(
    {
      error: failure.errorCode,
      tool,
      path: context.path as Report["path"],
      publication: mutation?.publication,
      message: boundedText(failure.message, budget.fieldBytes),
      cause: causeOf(failure.cause, budget.fieldBytes),
      ...failure.facts,
      then_run: mutation?.then_run,
      progressError: mutation?.progressError,
      next: failureNext(failure, mutation?.publication),
    } as FailureReport,
    budget,
  );
}

/** Run one tool execution, returning any failure as its report. */
export async function runTool<T>(
  tool: ReportTool,
  context: FailureContext,
  run: () => Promise<T>,
  describe: typeof describeFailure = describeFailure,
): Promise<T | AgentToolResult<ReportDetails<FailureReport>>> {
  try {
    return await run();
  } catch (error) {
    return failureResult(describe(tool, error, context));
  }
}

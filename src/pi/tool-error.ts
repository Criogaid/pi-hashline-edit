/** Execution error adapter. Classification and transport never append diagnostic prose. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { filesystemErrorCode, HashlineError } from "../core/errors.ts";
import type { ToolReport, ToolName, CommandFact, CauseFact } from "../core/report-schema.ts";
import { cancellationError } from "./error-text.ts";
import { FileMutationError, unpublishedMutationFact } from "./file-commit.ts";
import {
  boundedText,
  causeFacts,
  emptyReport,
  publishReport,
  renderModelReport,
  type ReportDetails,
} from "./report.ts";

export interface ErrorContext {
  readonly path?: string | string[];
  readonly mutation?: boolean;
  readonly signal?: AbortSignal;
}
export interface ErrorAnnotation {
  readonly command: CommandFact;
  readonly progressFailures?: CauseFact[];
}
/** Fusion annotates only its command and observer failures; mutation facts stay with their owner. */
export class AnnotatedError extends Error {
  readonly error: unknown;
  readonly annotation: ErrorAnnotation;
  constructor(error: unknown, annotation: ErrorAnnotation) {
    super("Fused mutation failed.", { cause: error });
    this.name = "AnnotatedError";
    this.error = error;
    this.annotation = annotation;
  }
}
export function unannotated(error: unknown): unknown {
  while (error instanceof AnnotatedError) error = error.error;
  return error;
}
function classify(error: unknown, signal?: AbortSignal): HashlineError {
  if (error instanceof HashlineError) return error;
  if (signal?.aborted) return cancellationError(error);
  return new HashlineError(
    filesystemErrorCode(error) ?? "UNCLASSIFIED",
    "External operation failed.",
    { cause: error },
  );
}
export function describeError(tool: ToolName, caught: unknown, context: ErrorContext): ToolReport {
  let error = caught;
  let annotation: ErrorAnnotation | undefined;
  while (error instanceof AnnotatedError) {
    annotation ??= error.annotation;
    error = error.error;
  }
  const failure = classify(error, context.signal);
  return {
    ...emptyReport(tool),
    outcome: "failure",
    ...(context.path === undefined ? {} : { path: context.path }),
    error: { ...failure.descriptor(), message: boundedText(failure.message) },
    ...(failure.cause === undefined ? {} : { causes: causeFacts(failure.cause) }),
    ...(context.mutation
      ? {
          mutation:
            failure instanceof FileMutationError
              ? failure.mutationFact()
              : unpublishedMutationFact(),
        }
      : {}),
    ...(annotation === undefined ? {} : annotation),
  };
}
/** Preparation must throw because Pi has not entered execute; the same renderer supplies its message. */
export class ReportedToolError extends Error {
  readonly report: ToolReport;
  constructor(report: ToolReport, cause?: unknown) {
    super(renderModelReport(report), { cause });
    this.name = "ReportedToolError";
    this.report = report;
  }
}
export async function reportToolErrors<T>(
  tool: ToolName,
  context: ErrorContext,
  run: () => Promise<AgentToolResult<T>>,
): Promise<AgentToolResult<T | ReportDetails>> {
  try {
    const result = await run();
    const base =
      reportOf(result) ??
      emptyReport(
        tool,
        result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      );
    const report = {
      ...base,
      ...(base.path === undefined && context.path !== undefined ? { path: context.path } : {}),
    };
    return publishReport(result, report);
  } catch (error) {
    const report = describeError(tool, error, context);
    return publishReport({ content: [], details: { report } }, report);
  }
}
/** Details are produced by this plugin; foreign host failures have no report and retain opaque text. */
export function reportOf(
  result: Pick<AgentToolResult<unknown>, "details">,
): ToolReport | undefined {
  const details = result.details;
  if (typeof details !== "object" || details === null || !("report" in details)) return undefined;
  return details.report as ToolReport;
}
/** Preserve preparation diagnostics without parsing transport text. Weak keys follow the host's raw argument objects. */
export function withToolReports<P extends TSchema, D, S>(
  tool: ToolDefinition<P, D, S>,
): ToolDefinition<P, D, S> {
  const preparationFailures = new WeakMap<object, ToolReport>();
  return {
    ...tool,
    prepareArguments:
      tool.prepareArguments &&
      ((args) => {
        if (typeof args === "object" && args !== null) preparationFailures.delete(args);
        try {
          return tool.prepareArguments!(args);
        } catch (error) {
          if (error instanceof ReportedToolError && typeof args === "object" && args !== null)
            preparationFailures.set(args, error.report);
          throw error;
        }
      }),
    renderResult:
      tool.renderResult &&
      ((result, options, theme, context) => {
        const preparedReport =
          typeof context.args === "object" && context.args !== null
            ? preparationFailures.get(context.args)
            : undefined;
        return tool.renderResult!(
          preparedReport && !reportOf(result)
            ? { ...result, details: Object.assign({}, result.details, { report: preparedReport }) }
            : result,
          options,
          theme,
          context,
        );
      }),
  };
}
/** Whole fact entries are bounded before rendering; omitted counts remain explicit. */
export function boundedFacts<T>(
  entries: readonly T[],
  maxBytes: number,
): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + (kept.length ? 1 : 0);
    if (bytes + entryBytes > maxBytes) break;
    kept.push(entry);
    bytes += entryBytes;
  }
  return { kept, omitted: entries.length - kept.length };
}

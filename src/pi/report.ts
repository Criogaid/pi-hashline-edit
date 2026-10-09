/** The model-facing renderer and Pi transport for the schema-owned report. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  errorDefinitions,
  recoveryText,
  type ToolReport,
  type CauseFact,
  type ToolName,
  type SuccessReport,
} from "../core/report-schema.ts";
import { errorMessage, errnoCode } from "../core/errors.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { MAX_ERROR_TEXT_BYTES, MAX_CAUSE_ENTRIES, MAX_BLOCK_BYTES } from "./budgets.ts";

export interface ReportDetails {
  readonly report: ToolReport;
}
export function boundedText(text: string, maxBytes = MAX_ERROR_TEXT_BYTES): string {
  const buffer = new DiagnosticBuffer(maxBytes);
  buffer.append(text);
  return buffer.toString();
}

/** External error boundary: preserve causal depth and aggregate branches within one bound. */
export function causeFacts(caught: unknown, maxBytes = MAX_BLOCK_BYTES): CauseFact[] {
  const result: CauseFact[] = [];
  const seen = new Set<unknown>();
  const pending = [{ error: caught, depth: 0, branch: undefined as number | undefined }];
  let omitted = 0;
  while (pending.length && result.length < MAX_CAUSE_ENTRIES) {
    const item = pending.shift();
    if (!item || seen.has(item.error)) continue;
    seen.add(item.error);
    const code = errnoCode(item.error);
    result.push({
      name: boundedText(
        item.error instanceof Error ? item.error.name : "ThrownValue",
        Math.floor(maxBytes / MAX_CAUSE_ENTRIES),
      ),
      message: boundedText(errorMessage(item.error), Math.floor(maxBytes / MAX_CAUSE_ENTRIES)),
      ...(code === undefined
        ? {}
        : { code: boundedText(code, Math.floor(maxBytes / MAX_CAUSE_ENTRIES)) }),
      depth: item.depth,
      ...(item.branch === undefined ? {} : { branch: item.branch }),
    });
    if (item.error instanceof AggregateError) {
      const remaining = MAX_CAUSE_ENTRIES - result.length - pending.length;
      const retained = item.error.errors.slice(0, remaining);
      omitted += item.error.errors.length - retained.length;
      retained.forEach((error: unknown, branch: number) =>
        pending.push({ error, depth: item.depth + 1, branch }),
      );
    }
    if (item.error instanceof Error && item.error.cause !== undefined) {
      if (pending.length + result.length < MAX_CAUSE_ENTRIES)
        pending.push({ error: item.error.cause, depth: item.depth + 1, branch: undefined });
      else omitted++;
    }
  }
  omitted += pending.length;
  const omission = (): CauseFact[] =>
    omitted ? [{ name: "Omitted", message: "", depth: 0, omitted }] : [];
  while (
    result.length > 1 &&
    Buffer.byteLength(JSON.stringify([...result, ...omission()])) > maxBytes
  ) {
    result.splice(result.length - 2, 1);
    omitted++;
  }
  if (omitted) result.push({ name: "Omitted", message: "", depth: 0, omitted });
  return result;
}

/** Recovery is one final field, derived from the report rather than added by producers. */
export function reportNext(report: ToolReport): string | undefined {
  const publication = report.mutation?.publication;
  if (publication === "UNKNOWN") return recoveryText.uncertain;
  if (report.outcome === "failure" && publication === "PUBLISHED")
    return `${recoveryText.published} ${recoveryText.reread}`;
  if (report.mutation?.freshness && report.mutation.freshness !== "unchanged")
    return recoveryText.reread;
  if (report.error) {
    const { code, recovery } = report.error;
    const definition = errorDefinitions[code];
    return (
      Object.entries(definition.overrides).find(([key]) => key === recovery)?.[1] ??
      (definition.next || undefined)
    );
  }
  if (report.read?.oversizedLine !== undefined)
    return "Reducing limit cannot split a physical line; use bash to inspect it in chunks, or replace for a known literal/regex change.";
  if (report.read?.nextOffset !== undefined)
    return `Continue with offset ${report.read.nextOffset}.`;
  if (report.search?.partialRows)
    return "Use read for complete line content before reconstructing a line.";
  if (report.search?.limitReached || report.search?.omittedRows)
    return "Increase limit or refine the query to inspect more results.";
  if (report.anchors?.omitted) return "Use read for omitted anchor positions.";
  return undefined;
}

/** Exactly one JSON record for metadata and textual payload; image blocks remain native images. */
export function renderModelReport(report: ToolReport): string {
  const next = reportNext(report);
  return JSON.stringify(
    {
      version: report.version,
      tool: report.tool,
      outcome: report.outcome,
      ...(report.path === undefined ? {} : { path: report.path }),
      ...(report.error === undefined
        ? {}
        : { error: report.error.code, message: report.error.message, facts: report.error.facts }),
      ...(report.causes?.length ? { causes: report.causes } : {}),
      ...(report.mutation === undefined ? {} : { mutation: report.mutation }),
      ...(report.command === undefined ? {} : { command: report.command }),
      ...(report.read === undefined ? {} : { read: report.read }),
      ...(report.search === undefined ? {} : { search: report.search }),
      ...(report.edit === undefined ? {} : { edit: report.edit }),
      ...(report.replace === undefined ? {} : { replace: report.replace }),
      ...(report.forget === undefined ? {} : { forget: report.forget }),
      ...(report.anchors === undefined ? {} : { anchors: report.anchors }),
      ...(report.progressFailures?.length ? { progressFailures: report.progressFailures } : {}),
      ...(report.payload.length ? { payload: report.payload } : {}),
      ...(next === undefined ? {} : { next }),
    },
    null,
    2,
  );
}

/** A successful post-process report exists only after mutation execution and result generation. */
export function mutationCompleted(report: ToolReport | undefined): boolean {
  return report?.outcome === "success" && report.mutation?.stage === "post_process";
}

export function emptyReport(tool: ToolName, payload: string[] = []): SuccessReport {
  return { version: 1, tool, outcome: "success", payload };
}
export function publishReport<T>(
  result: AgentToolResult<T>,
  report: ToolReport,
): AgentToolResult<T & ReportDetails> {
  return {
    ...result,
    content: [
      { type: "text", text: renderModelReport(report) },
      ...result.content.filter((block) => block.type === "image"),
      ...(result.details &&
      typeof result.details === "object" &&
      "resultTag" in result.details &&
      typeof result.details.resultTag === "string"
        ? [{ type: "text" as const, text: result.details.resultTag }]
        : []),
    ],
    details: Object.assign({}, result.details, { report }),
    ...(report.outcome === "failure" ? { isError: true } : {}),
  };
}

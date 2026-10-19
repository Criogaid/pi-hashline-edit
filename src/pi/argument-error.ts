/**
 * Model-facing argument rejection: an `INVALID_ARGUMENTS` report (report.ts)
 * with field issues within one byte budget. Pi raises it before execution,
 * so it travels as the thrown message only. Oversized issues are omitted whole.
 */
import { DEFAULT_OUTPUT_BUDGETS, type OutputBudgets } from "./budgets.ts";
import { boundedText, renderReport, type ReportText } from "./report.ts";
import type { ArgumentIssue, FailureReport } from "./report-schema.ts";

type ArgumentRejection = ReportText<Extract<FailureReport, { error: "INVALID_ARGUMENTS" }>>;

/**
 * State each distinct fix once, on the first reported issue that needs it:
 * later issues with the same fix state only their reason.
 */
function fixesOnce(issues: readonly ArgumentIssue[]): ArgumentIssue[] {
  const fixes = new Set<string>();
  return issues.map(({ field, reason, fix }) => {
    const repeated = fix === undefined || fixes.has(fix);
    if (fix !== undefined) fixes.add(fix);
    return repeated ? { field, reason } : { field, reason, fix };
  });
}

/** One rejection as text; issues are deduplicated after any omission so no kept issue loses its fix. */
function encode(report: ArgumentRejection): string {
  return renderReport({ ...report, issues: fixesOnce(report.issues) });
}

/** Encode actionable field diagnostics without repeating the call's arguments. */
export function formatArgumentError(
  issues: readonly ArgumentIssue[],
  schemaLimited: boolean,
  budget: OutputBudgets = DEFAULT_OUTPUT_BUDGETS,
): string {
  const boundedIssues = issues.map(({ field, reason, fix }) => ({
    field,
    reason: boundedText(reason, budget.fieldBytes),
    ...(fix === undefined ? {} : { fix: boundedText(fix, budget.fieldBytes) }),
  }));
  const base = {
    error: "INVALID_ARGUMENTS" as const,
    ...(schemaLimited ? { schemaLimited: true as const } : {}),
  };
  const fits = (text: string) => Buffer.byteLength(text) <= budget.blockBytes;
  const complete = encode({ ...base, issues: boundedIssues });
  if (fits(complete)) return complete;

  // An oversized field path must be omitted whole: a shortened path could name another field.
  const eligible = boundedIssues.filter((issue) =>
    fits(
      encode({
        ...base,
        issues: [issue],
        omittedIssues: boundedIssues.length - 1 || undefined,
      }),
    ),
  );
  const frame = (count: number) => {
    const head = Math.ceil(count / 2);
    const tail = count - head;
    return encode({
      ...base,
      issues: [...eligible.slice(0, head), ...(tail ? eligible.slice(-tail) : [])],
      omittedIssues: boundedIssues.length - count || undefined,
    });
  };
  let low = 0;
  let high = eligible.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(frame(middle))) low = middle;
    else high = middle - 1;
  }
  return frame(low);
}

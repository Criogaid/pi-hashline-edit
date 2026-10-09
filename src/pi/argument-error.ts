/**
 * Model-facing argument rejection: an `INVALID_ARGUMENTS` report (report.ts)
 * with the issues and argument copy as its facts, within one byte budget. Pi
 * raises it before execution, so it travels as the thrown message only.
 * The JSON is never truncated; whole issues or the argument copy are omitted.
 */
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import { boundedText, renderReport, type Report } from "./report.ts";
import type { ArgumentIssue } from "./report-schema.ts";

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
function encode(report: Report & { issues: readonly ArgumentIssue[] }): string {
  return renderReport({ ...report, issues: fixesOnce(report.issues) });
}

/** Encode prepared arguments once; unsupported values and oversized copies are explicitly omitted. */
export function formatArgumentError(
  tool: string,
  issues: readonly ArgumentIssue[],
  prepared: unknown,
  schemaLimited: boolean,
): string {
  const boundedIssues = issues.map(({ field, reason, fix }) => ({
    field,
    reason: boundedText(reason),
    ...(fix === undefined ? {} : { fix: boundedText(fix) }),
  }));
  const base: Report = {
    error: "INVALID_ARGUMENTS",
    tool,
    ...(schemaLimited ? { schemaLimited: true as const } : {}),
  };
  const fits = (text: string) => Buffer.byteLength(text) <= MAX_BLOCK_BYTES;
  let argumentsCopy: unknown;
  let argumentsAvailable = false;
  try {
    const encoded = JSON.stringify(prepared, (_key, value: unknown) => {
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError("Prepared arguments contain a value JSON cannot represent");
      }
      return value;
    });
    if (encoded !== undefined && fits(encoded)) {
      argumentsCopy = JSON.parse(encoded);
      argumentsAvailable = true;
    }
  } catch {
    // Pi preparation can fail before producing a JSON value (for example, a cycle).
    // Report the original cause through issues and label the missing argument copy.
  }
  if (argumentsAvailable) {
    const complete = encode({ ...base, issues: boundedIssues, arguments: argumentsCopy });
    if (fits(complete)) return complete;
  }
  const withoutArguments: Report = { ...base, argumentsOmitted: true };
  const complete = encode({ ...withoutArguments, issues: boundedIssues });
  if (fits(complete)) return complete;

  // An oversized field path must be omitted whole: a shortened path could name another field.
  const eligible = boundedIssues.filter((issue) =>
    fits(
      encode({
        ...withoutArguments,
        issues: [issue],
        omittedIssues: boundedIssues.length - 1 || undefined,
      }),
    ),
  );
  const frame = (count: number) => {
    const head = Math.ceil(count / 2);
    const tail = count - head;
    return encode({
      ...withoutArguments,
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

/** Bounded argument facts in the same report used by execution results. */
import type { ArgumentIssue, ErrorFacts, ToolName, ToolReport } from "../core/report-schema.ts";
import { MAX_ERROR_TEXT_BYTES, MAX_BLOCK_BYTES } from "./budgets.ts";
import { boundedText, causeFacts, emptyReport, renderModelReport } from "./report.ts";
import { unpublishedMutationFact } from "./file-commit.ts";
export type ArgumentError = ErrorFacts<"INVALID_ARGUMENTS">;

export function argumentReport(
  tool: ToolName,
  issues: readonly ArgumentIssue[],
  prepared: unknown,
  schemaLimited: boolean,
  preparationCause?: unknown,
): ToolReport {
  const bounded = issues.map(({ field, fact, fix }) => ({
    field,
    fact: boundedText(fact, MAX_ERROR_TEXT_BYTES),
    ...(fix === undefined ? {} : { fix: boundedText(fix, MAX_ERROR_TEXT_BYTES) }),
  }));
  const base = {
    executed: false as const,
    issues: bounded,
    ...(schemaLimited ? { schemaLimited: true as const } : {}),
  };
  const report = (facts: ArgumentError): ToolReport => ({
    ...emptyReport(tool),
    outcome: "failure",
    ...(["edit", "replace", "write"].includes(tool) ? { mutation: unpublishedMutationFact() } : {}),
    error: {
      code: "INVALID_ARGUMENTS",
      message: "Arguments were rejected before execution.",
      facts,
    },
    ...(preparationCause === undefined
      ? {}
      : { causes: causeFacts(preparationCause, MAX_ERROR_TEXT_BYTES) }),
  });
  const fits = (facts: ArgumentError) =>
    Buffer.byteLength(renderModelReport(report(facts))) <= MAX_BLOCK_BYTES;
  let argumentsCopy: unknown;
  let available = false;
  try {
    const encoded = JSON.stringify(prepared, (_key, value: unknown) => {
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new TypeError("Prepared arguments are not JSON values.");
      return value;
    });
    if (encoded !== undefined && Buffer.byteLength(encoded) <= MAX_BLOCK_BYTES) {
      argumentsCopy = JSON.parse(encoded);
      available = true;
    }
  } catch {
    // Failed preparation may leave cycles or values JSON cannot represent; explicitly omit the copy.
  }
  if (available && fits({ ...base, arguments: argumentsCopy }))
    return report({ ...base, arguments: argumentsCopy });
  const withoutArguments = { ...base, argumentsOmitted: true as const };
  if (fits(withoutArguments)) return report(withoutArguments);
  const eligible = bounded.filter((issue) =>
    fits({ ...withoutArguments, issues: [issue], omittedIssues: bounded.length - 1 }),
  );
  const frame = (count: number): ArgumentError => {
    const head = Math.ceil(count / 2);
    const tail = count - head;
    return {
      ...withoutArguments,
      issues: [...eligible.slice(0, head), ...(tail ? eligible.slice(-tail) : [])],
      omittedIssues: bounded.length - count,
    };
  };
  let low = 0,
    high = eligible.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(frame(middle))) low = middle;
    else high = middle - 1;
  }
  return report(frame(low));
}

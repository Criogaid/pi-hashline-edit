/**
 * Shared tool argument boundary. Prepare with Pi's schema engine so semantic
 * checks and bounded diagnostics see the same coerced value, including on
 * schema failure. Pi still validates the original arguments after preparation.
 * Tool schemas have no cross-field constraints.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { Static, TObject } from "typebox";
import { errorMessage } from "../core/errors.ts";
import { buildRegex } from "../core/regex.ts";
import { diagnoseArguments } from "./argument-diagnostics.ts";
import { formatArgumentError } from "./argument-error.ts";
import type { OutputBudgetProvider } from "./budgets.ts";
import type { ArgumentIssue, ReportTool } from "./report-schema.ts";

/** Report one semantic issue: what is wrong (a fact), and how to correct it when the fact alone does not say. */
export type ReportArgumentIssue = (field: string, reason: string, fix?: string) => void;
export type CheckArguments = (args: unknown, report: ReportArgumentIssue) => void;

/**
 * Report V8's diagnostics for a rule's flags and, in regex mode, for each pattern that
 * buildRegex would reject. Invalid flags stop the check, since every pattern compiles with
 * them; values that are not strings are left to schema validation.
 */
export function checkRegexArguments(
  flagsField: string,
  flags: string | undefined,
  literal: boolean,
  patterns: readonly (readonly [field: string, value: unknown])[],
  report: ReportArgumentIssue,
): void {
  try {
    buildRegex("", true, flags);
  } catch (error) {
    report(flagsField, errorMessage(error));
    return;
  }
  if (literal) return;
  for (const [field, value] of patterns) {
    if (typeof value !== "string") continue;
    try {
      buildRegex(value, false, flags);
    } catch (error) {
      report(
        field,
        errorMessage(error),
        "For an exact-text match, set literal to true; otherwise correct the regex syntax.",
      );
    }
  }
}

/** Inspect arrays and the singleton objects Pi may coerce, without changing input. */
export function argumentItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
}

function preparationError(cause: unknown, limited: boolean, budgets: OutputBudgetProvider): Error {
  return new Error(
    formatArgumentError([{ field: "$", reason: errorMessage(cause) }], limited, budgets()),
    { cause },
  );
}

export function createArgumentPreparer<T extends TObject>(
  name: ReportTool,
  parameters: T,
  check: CheckArguments | undefined,
  budgets: OutputBudgetProvider,
): (args: unknown) => Static<T> {
  // Match pi-ai's validateToolArguments compile options.
  const validator = compile(parameters, { formats, coerce: true, unresolvedRefs: "reject" });

  return (args) => {
    let checked: unknown;
    let schemaFailed: boolean;
    try {
      // parse() only returns errors on failure. Keep the coerced value for both
      // semantic checks and the bounded, per-field diagnostic pass.
      checked = validator.coerce(structuredClone(args));
      schemaFailed = !validator.check(checked);
    } catch (error) {
      throw preparationError(error, false, budgets);
    }
    const issues: ArgumentIssue[] = [];
    check?.(checked, (field, reason, fix) =>
      issues.push(fix === undefined ? { field, reason } : { field, reason, fix }),
    );
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    if (!schemaFailed && issues.length === 0) return args as Static<T>;
    const result = diagnoseArguments(parameters, checked, issues, schemaFailed);
    if (result.issues.length > 0) {
      throw new Error(formatArgumentError(result.issues, result.limited, budgets()));
    }

    // Preserve Pi's original failure when projection has no issue to report.
    try {
      validateToolArguments(
        { name, parameters, description: "" },
        {
          type: "toolCall",
          id: "argument-validation",
          name,
          arguments: args as ToolCall["arguments"],
        },
      );
    } catch (error) {
      throw preparationError(error, result.limited, budgets);
    }
    return args as Static<T>;
  };
}

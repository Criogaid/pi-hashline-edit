/**
 * Shared tool argument boundary. Pi owns preparation and acceptance; tool checks
 * report semantic issues. Failure-only diagnostics use pi-schema's public coercer,
 * then project and aggregate the declared schema in argument-diagnostics.ts.
 * Pi still validates returned arguments in its mandatory tool-call pipeline.
 * Tool schemas have no cross-field constraints.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { Static, TObject } from "typebox";
import { errorMessage } from "../core/errors.ts";
import { diagnoseArguments } from "./argument-diagnostics.ts";
import { formatArgumentError } from "./argument-error.ts";
import type { OutputBudgetProvider } from "./budgets.ts";
import type { ArgumentIssue, ReportTool } from "./report-schema.ts";

/** Report one semantic issue: what is wrong (a fact), and how to correct it when the fact alone does not say. */
export type ReportArgumentIssue = (field: string, reason: string, fix?: string) => void;
export type CheckArguments = (args: unknown, report: ReportArgumentIssue) => void;

/** Inspect arrays and the singleton objects Pi may coerce, without changing input. */
export function argumentItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
}

export function createArgumentPreparer<T extends TObject>(
  name: ReportTool,
  parameters: T,
  check: CheckArguments | undefined,
  budgets: OutputBudgetProvider,
): (args: unknown) => Static<T> {
  const diagnosticValidator = compile(parameters, {
    formats,
    coerce: true,
    unresolvedRefs: "reject",
  });

  return (args) => {
    let checked: unknown = args;
    let schemaFailure: unknown;
    try {
      checked = validateToolArguments(
        { name, parameters, description: "" },
        // Pi owns shape checking and coercion at this external boundary.
        {
          type: "toolCall",
          id: "argument-validation",
          name,
          arguments: args as ToolCall["arguments"],
        },
      );
    } catch (error) {
      schemaFailure = error;
    }
    if (schemaFailure !== undefined) {
      try {
        checked = diagnosticValidator.coerce(structuredClone(args));
      } catch {
        // Preparation failures retain Pi's original cause in the shared error envelope.
        throw new Error(
          formatArgumentError(
            [{ field: "$", reason: errorMessage(schemaFailure) }],
            false,
            budgets(),
          ),
          { cause: schemaFailure },
        );
      }
    }
    const issues: ArgumentIssue[] = [];
    check?.(checked, (field, reason, fix) =>
      issues.push(fix === undefined ? { field, reason } : { field, reason, fix }),
    );
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    if (schemaFailure === undefined && issues.length === 0) return args as Static<T>;
    const result = diagnoseArguments(parameters, checked, issues, schemaFailure !== undefined);
    const reported =
      result.issues.length > 0
        ? result.issues
        : [{ field: "$", reason: errorMessage(schemaFailure) }];
    throw new Error(formatArgumentError(reported, result.limited, budgets()), {
      cause: schemaFailure,
    });
  };
}

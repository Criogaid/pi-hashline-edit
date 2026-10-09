/**
 * Shared tool argument boundary. Pi owns preparation and acceptance; tool checks
 * report semantic issues. Failure-only diagnostics observe Pi's prepared value,
 * then project and aggregate the declared schema in argument-diagnostics.ts.
 * Pi still validates returned arguments in its mandatory tool-call pipeline.
 * Tool schemas have no cross-field constraints.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { ObjectOptions, Type, type Static, type TObject, type TSchema } from "typebox";
import { errorMessage } from "../core/errors.ts";
import { diagnoseArguments, type ArgumentIssue } from "./argument-diagnostics.ts";
import { formatArgumentError } from "./argument-error.ts";

export type ReportArgumentIssue = (field: string, reason: string) => void;
type CheckArguments = (args: unknown, report: ReportArgumentIssue) => void;

/** Inspect arrays and the singleton objects Pi may coerce, without changing input. */
export function argumentItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
}

export function createArgumentPreparer<T extends TObject>(
  name: string,
  parameters: T,
  check?: CheckArguments,
): (args: unknown) => Static<T> {
  const validate = (schema: TSchema, args: unknown): unknown =>
    validateToolArguments(
      { name, parameters: schema, description: "" },
      // Pi owns shape checking and coercion at this external boundary.
      {
        type: "toolCall",
        id: "argument-validation",
        name,
        arguments: args as ToolCall["arguments"],
      },
    );

  return (args) => {
    let checked: unknown = args;
    let schemaFailure: unknown;
    try {
      checked = validate(parameters, args);
    } catch (error) {
      schemaFailure = error;
    }
    if (schemaFailure !== undefined) {
      let observation: { readonly value: unknown } | undefined;
      // Pi does not expose failed prepared values. A successful allOf refinement
      // observes its error pass without changing coercion, null handling or acceptance.
      const observer = Type.Object(parameters.properties, {
        ...ObjectOptions(parameters),
        allOf: [
          Type.Refine(Type.Unknown(), (value: unknown) => {
            observation = { value };
            return true;
          }),
        ],
      });
      try {
        validate(observer, args);
      } catch {
        // The original schema already failed; this call only observes preparation.
      }
      if (!observation) {
        throw new Error(
          formatArgumentError(
            name,
            [{ field: "$", reason: errorMessage(schemaFailure) }],
            undefined,
            false,
          ),
          { cause: schemaFailure },
        );
      }
      checked = observation.value;
    }
    const issues: ArgumentIssue[] = [];
    check?.(checked, (field, reason) => issues.push({ field, reason }));
    if (schemaFailure === undefined && issues.length === 0) return args as Static<T>;
    const result = diagnoseArguments(parameters, checked, issues, schemaFailure !== undefined);
    const reported =
      result.issues.length > 0
        ? result.issues
        : [{ field: "$", reason: errorMessage(schemaFailure) }];
    if (schemaFailure !== undefined || result.issues.length > 0) {
      throw new Error(formatArgumentError(name, reported, checked, result.limited), {
        cause: schemaFailure,
      });
    }
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    return args as Static<T>;
  };
}

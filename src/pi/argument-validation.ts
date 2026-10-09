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
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { invalidArgument } from "./error-text.ts";

export type ReportArgumentIssue = (field: string, reason: string) => void;
type CheckArguments = (args: unknown, report: ReportArgumentIssue) => void;

/** Inspect arrays and the singleton objects Pi may coerce, without changing input. */
export function argumentItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
}

/** Compact Pi 0.99.1's exact argument suffix; preserve an unrecognised format. */
function schemaDiagnostic(error: unknown, args: unknown): string {
  const message = errorMessage(error);
  const label = "Received arguments:";
  const suffix = `\n\n${label}\n${JSON.stringify(args, null, 2)}`;
  if (!message.endsWith(suffix)) return message;
  return `${message.slice(0, -suffix.length)}\n${label} ${JSON.stringify(args)}`;
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
        const diagnostics = new DiagnosticBuffer(MAX_BLOCK_BYTES);
        diagnostics.append(schemaDiagnostic(schemaFailure, args));
        throw new Error(diagnostics.toString().trimEnd(), { cause: schemaFailure });
      }
      checked = observation.value;
    }
    const issues: ArgumentIssue[] = [];
    check?.(checked, (field, reason) => issues.push({ field, reason }));
    if (schemaFailure === undefined && issues.length === 0) return args as Static<T>;
    const result = diagnoseArguments(parameters, checked, issues, schemaFailure !== undefined);
    const diagnostics = new DiagnosticBuffer(MAX_BLOCK_BYTES);
    for (const issue of result.semanticIssues) {
      diagnostics.append(`${invalidArgument(issue.field, issue.reason).message}\n`);
    }
    if (result.schemaIssues.length > 0) {
      diagnostics.append(`Validation failed for tool "${name}":\n`);
      for (const issue of result.schemaIssues)
        diagnostics.append(`  - ${issue.field}: ${issue.reason}\n`);
      diagnostics.append(`Received arguments: ${JSON.stringify(args)}\n`);
    }
    if (result.limited) {
      diagnostics.append(
        "\nPi limits schema diagnostics within each field; additional errors may remain.\n",
      );
    }
    if (
      schemaFailure !== undefined &&
      result.schemaIssues.length === 0 &&
      result.semanticIssues.length === 0
    ) {
      diagnostics.append(schemaDiagnostic(schemaFailure, args));
    }
    if (schemaFailure !== undefined || result.semanticIssues.length > 0) {
      throw new Error(diagnostics.toString().trimEnd(), { cause: schemaFailure });
    }
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    return args as Static<T>;
  };
}

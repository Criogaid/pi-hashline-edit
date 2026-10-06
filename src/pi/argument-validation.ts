/**
 * Shared argument preparation for every tool. Tool checks only report independent
 * field issues; this boundary combines them with Pi's schema diagnostics and throws
 * once. Pi still validates returned arguments in its mandatory tool-call pipeline.
 * Failure diagnostics validate independent top-level fields separately so an invalid
 * union in one field cannot exhaust Pi's error budget for another. Tool schemas have
 * no cross-field constraints. Arguments and TypeBox's process-wide settings are not changed.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { ObjectOptions } from "typebox/type";
import { errorMessage } from "../core/errors.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { invalidArgument } from "./error-text.ts";

export type ReportArgumentIssue = (field: string, reason: string) => void;
type CheckArguments = (args: unknown, report: ReportArgumentIssue) => void;

/** Inspect arrays and the singleton objects Pi may coerce, without changing input. */
export function argumentItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
}

/**
 * Compact the exact argument suffix emitted by Pi 0.99.1's validateToolArguments.
 * If Pi changes that format, preserve its full error unchanged, including multiline JSON.
 */
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
  const fields = Object.keys(parameters.properties);
  const options = { additionalProperties: ObjectOptions(parameters).additionalProperties };
  const fieldSchemas = fields.map((field) => ({
    field,
    schema: Type.Pick(parameters, [field], options),
  }));
  const unknownFieldsSchema = Type.Omit(parameters, fields, options);
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
    const diagnostics = new DiagnosticBuffer(MAX_BLOCK_BYTES);
    let hasIssues = schemaFailure !== undefined;
    check?.(checked, (field, reason) => {
      hasIssues = true;
      diagnostics.append(`${invalidArgument(field, reason).message}\n`);
    });
    if (schemaFailure !== undefined) {
      if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        const entries = Object.entries(args);
        const diagnose = (schema: TSchema, value: unknown) => {
          try {
            validate(schema, value);
          } catch (error) {
            diagnostics.append(`${schemaDiagnostic(error, value)}\n`);
          }
        };
        for (const { field, schema } of fieldSchemas) {
          diagnose(schema, Object.fromEntries(entries.filter(([key]) => key === field)));
        }
        diagnose(
          unknownFieldsSchema,
          Object.fromEntries(entries.filter(([key]) => !fields.includes(key))),
        );
      } else {
        diagnostics.append(schemaDiagnostic(schemaFailure, args));
      }
      diagnostics.append(
        "\nPi limits schema diagnostics within each field; additional errors may remain.\n",
      );
    }
    if (hasIssues) throw new Error(diagnostics.toString().trimEnd(), { cause: schemaFailure });
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    return args as Static<T>;
  };
}

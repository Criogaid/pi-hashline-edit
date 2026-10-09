/**
 * Shared argument preparation for every tool. Tool checks only report independent
 * field issues; this boundary combines them with Pi's schema diagnostics and throws
 * once. Pi still validates returned arguments in its mandatory tool-call pipeline.
 * Failure diagnostics select a uniquely matching literal-tagged object branch and omit
 * schema issues already explained by tool checks. Independent top-level fields retain
 * separate Pi error budgets. Validation still uses the original schema and Pi pipeline.
 * Tool schemas have no cross-field constraints.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import {
  ArrayOptions,
  IsArray,
  IsLiteral,
  IsObject,
  IsOptional,
  IsUnion,
  ObjectOptions,
  Type,
  UnionOptions,
  type Static,
  type TObject,
  type TSchema,
} from "typebox";
import { Value } from "typebox/value";
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

/** Literal tags only: overlapping or unrecognised tags keep the original union diagnostics. */
function isLiteralTag(schema: TSchema): boolean {
  return IsLiteral(schema) || (IsUnion(schema) && schema.anyOf.every(IsLiteral));
}

/** Project diagnostics from the declared schema; never use this projection to accept input. */
function diagnosticSchema(
  schema: TSchema,
  value: unknown,
  path: string,
  explained: ReadonlySet<string>,
): TSchema {
  if (explained.has(path)) {
    return IsOptional(schema) ? Type.Optional(Type.Unknown()) : Type.Unknown();
  }
  if (IsUnion(schema) && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const branches = schema.anyOf.filter(IsObject);
    const first = branches[0];
    if (first && branches.length === schema.anyOf.length) {
      const tag = Object.keys(first.properties).find((key) =>
        branches.every(
          (branch) => branch.required?.includes(key) && isLiteralTag(branch.properties[key]),
        ),
      );
      if (tag) {
        const matches = branches.filter((branch) =>
          Value.Check(branch.properties[tag], Reflect.get(value, tag)),
        );
        if (matches.length === 1) {
          // Keep the union boundary: Pi normalizes optional nulls only inside object schemas.
          return Type.Union(
            [diagnosticSchema(matches[0], value, path, explained)],
            UnionOptions(schema),
          );
        }
      }
    }
  }
  if (IsObject(schema) && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        diagnosticSchema(child, Reflect.get(value, key), path ? `${path}.${key}` : key, explained),
      ]),
    );
    return { ...schema, properties };
  }
  if (IsArray(schema) && Array.isArray(value)) {
    const items = value.map((item, index) =>
      diagnosticSchema(schema.items, item, `${path}[${index}]`, explained),
    );
    if (items.every((item) => item === schema.items)) return schema;
    return Type.Tuple(items, ArrayOptions(schema));
  }
  return schema;
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
    const explained = new Set<string>();
    check?.(checked, (field, reason) => {
      hasIssues = true;
      explained.add(field);
      diagnostics.append(`${invalidArgument(field, reason).message}\n`);
    });
    if (schemaFailure !== undefined) {
      let hasSchemaDiagnostics = false;
      if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        const entries = Object.entries(args);
        const diagnose = (schema: TSchema, value: unknown) => {
          try {
            validate(diagnosticSchema(schema, value, "", explained), value);
          } catch (error) {
            hasSchemaDiagnostics = true;
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
        hasSchemaDiagnostics = true;
        diagnostics.append(schemaDiagnostic(schemaFailure, args));
      }
      if (hasSchemaDiagnostics) {
        diagnostics.append(
          "\nPi limits schema diagnostics within each field; additional errors may remain.\n",
        );
      }
    }
    if (hasIssues) throw new Error(diagnostics.toString().trimEnd(), { cause: schemaFailure });
    // Keep Pi's preparation contract: the framework performs its own coercion next.
    return args as Static<T>;
  };
}

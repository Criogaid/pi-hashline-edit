/** Failure-only schema projection and structured error aggregation; Pi owns input preparation and acceptance. */
import {
  ArrayOptions,
  IsArray,
  IsLiteral,
  IsObject,
  IsOptional,
  ObjectOptions,
  IsUnion,
  Type,
  type TLiteralValue,
  type TObject,
  type TSchema,
  type TUnion,
} from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";

export interface ArgumentIssue {
  readonly field: string;
  readonly reason: string;
}
export interface ArgumentDiagnostics {
  readonly issues: readonly ArgumentIssue[];
  readonly limited: boolean;
}

function literalValues(schema: TSchema): readonly TLiteralValue[] | undefined {
  if (IsLiteral(schema)) return [schema.const];
  if (!IsUnion(schema)) return undefined;
  const values = schema.anyOf.map(literalValues);
  const choices = values.filter((value) => value !== undefined);
  return choices.length === values.length ? choices.flat() : undefined;
}

function objectTag(schema: TUnion):
  | {
      readonly field: string;
      readonly branches: readonly TObject[];
      readonly choices: readonly TLiteralValue[];
    }
  | undefined {
  const branches = schema.anyOf.filter(IsObject);
  const first = branches[0];
  if (!first || branches.length !== schema.anyOf.length) return undefined;
  for (const field of Object.keys(first.properties)) {
    if (!branches.every((branch) => branch.required?.includes(field))) continue;
    const values = branches.map((branch) => literalValues(branch.properties[field]));
    const choices = values.filter((value) => value !== undefined);
    if (choices.length === branches.length) return { field, branches, choices: choices.flat() };
  }
  return undefined;
}

function projectSchema(
  schema: TSchema,
  value: unknown,
  path: string,
  explained: ReadonlySet<string>,
  applicable: Set<string>,
): TSchema {
  const projected = projectValueSchema(schema, value, path, explained, applicable);
  return IsOptional(schema) && !IsOptional(projected) ? Type.Optional(projected) : projected;
}

function projectValueSchema(
  schema: TSchema,
  value: unknown,
  path: string,
  explained: ReadonlySet<string>,
  applicable: Set<string>,
): TSchema {
  if (IsUnion(schema)) {
    const choices = literalValues(schema);
    if (choices) {
      applicable.add(path);
      return Type.Unknown({ enum: [...new Set(choices)] });
    }
    const tag = objectTag(schema);
    if (tag) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return Type.Unknown({ type: "object" });
      const matches = tag.branches.filter((branch) =>
        Value.Check(branch.properties[tag.field], Reflect.get(value, tag.field)),
      );
      if (matches.length === 1)
        return projectSchema(matches[0], value, path, explained, applicable);
      if (matches.length === 0)
        return Type.Object({ [tag.field]: Type.Unknown({ enum: [...new Set(tag.choices)] }) });
      return schema;
    }
    const typed = schema.anyOf.filter((branch) => "type" in branch);
    if (typed.length === schema.anyOf.length) {
      const matches = typed.filter(
        (branch) => "type" in branch && Value.Check(Type.Unknown({ type: branch.type }), value),
      );
      if (matches.length === 1)
        return projectSchema(matches[0], value, path, explained, applicable);
      if (matches.length === 0) {
        const types = typed.flatMap((branch) =>
          "type" in branch ? (Array.isArray(branch.type) ? branch.type : [branch.type]) : [],
        );
        return Type.Unknown({ type: [...new Set(types)] });
      }
    }
    return schema;
  }
  if ("type" in schema && !Value.Check(Type.Unknown({ type: schema.type }), value)) return schema;
  applicable.add(path);
  if (explained.has(path)) return Type.Unknown();
  if (IsObject(schema) && typeof value === "object" && value !== null) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        projectSchema(
          child,
          Reflect.get(value, key),
          propertyPath(path, key),
          explained,
          applicable,
        ),
      ]),
    );
    return Type.Object(properties, ObjectOptions(schema));
  }
  if (IsArray(schema) && Array.isArray(value)) {
    const items = value.map((item, index) =>
      projectSchema(schema.items, item, `${path}[${index}]`, explained, applicable),
    );
    return items.every((item) => item === schema.items)
      ? schema
      : Type.Tuple(items, ArrayOptions(schema));
  }
  return schema;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(key)
    ? path
      ? `${path}.${key}`
      : key
    : `${path}[${JSON.stringify(key)}]`;
}

function fieldPath(pointer: string, prepared: unknown, key?: string): string {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value = prepared;
  let path = "";
  for (const part of parts) {
    path = Array.isArray(value) ? `${path}[${part}]` : propertyPath(path, part);
    value = typeof value === "object" && value !== null ? Reflect.get(value, part) : undefined;
  }
  return (key === undefined ? path : propertyPath(path, key)) || "$";
}

function combineIssues(issues: readonly ArgumentIssue[]): readonly ArgumentIssue[] {
  const reasons = new Map<string, Set<string>>();
  for (const { field, reason } of issues) {
    const existing = reasons.get(field) ?? new Set<string>();
    existing.add(reason);
    reasons.set(field, existing);
  }
  return [...reasons].map(([field, values]) => ({ field, reason: [...values].join("; ") }));
}

function aggregateErrors(
  errors: readonly TLocalizedValidationError[],
  prepared: unknown,
): readonly ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  const add = (field: string, reason: string) => issues.push({ field, reason });
  for (const error of errors) {
    if (
      error.keyword === "anyOf" &&
      errors.some(
        (child) =>
          child !== error &&
          child.keyword !== "anyOf" &&
          (child.instancePath === error.instancePath ||
            child.instancePath.startsWith(`${error.instancePath}/`)),
      )
    )
      continue;
    switch (error.keyword) {
      case "required":
        for (const key of error.params.requiredProperties)
          add(fieldPath(error.instancePath, prepared, key), "is required");
        break;
      case "additionalProperties":
        for (const key of error.params.additionalProperties)
          add(fieldPath(error.instancePath, prepared, key), "is not allowed");
        break;
      case "boolean":
        add(fieldPath(error.instancePath, prepared), "is not allowed");
        break;
      case "enum":
        add(
          fieldPath(error.instancePath, prepared),
          `expected one of: ${error.params.allowedValues.map((value) => JSON.stringify(value)).join(", ")}`,
        );
        break;
      default:
        add(fieldPath(error.instancePath, prepared), error.message);
    }
  }
  return combineIssues(issues);
}

/** Detect native capacity through a terminal error, without importing unbundled TypeBox settings. */
function boundedErrors(
  schema: TSchema,
  value: unknown,
): {
  readonly errors: readonly TLocalizedValidationError[];
  readonly limited: boolean;
} {
  const terminalPath = "#/allOf/1";
  const errors = Value.Errors(Type.Unknown({ allOf: [schema, Type.Never()] }), value);
  const terminal = (error: TLocalizedValidationError) =>
    error.schemaPath === terminalPath || error.schemaPath.startsWith(`${terminalPath}/`);
  return { errors: errors.filter((error) => !terminal(error)), limited: !errors.some(terminal) };
}

/** Diagnose prepared values without repeating Pi's coercion or optional-null rules. */
export function diagnoseArguments(
  parameters: TObject,
  prepared: unknown,
  semanticIssues: readonly ArgumentIssue[],
  schemaFailed: boolean,
): ArgumentDiagnostics {
  const applicable = new Set<string>();
  const projected = projectSchema(
    parameters,
    prepared,
    "",
    new Set(semanticIssues.map((issue) => issue.field)),
    applicable,
  );
  const retained = combineIssues(semanticIssues.filter((issue) => applicable.has(issue.field)));
  if (!schemaFailed) return { issues: retained, limited: false };
  const batches =
    IsObject(projected) &&
    typeof prepared === "object" &&
    prepared !== null &&
    !Array.isArray(prepared)
      ? Object.keys(parameters.properties)
          .map((field) =>
            boundedErrors(
              Type.Pick(projected, [field], { additionalProperties: false }),
              Object.fromEntries(Object.entries(prepared).filter(([key]) => key === field)),
            ),
          )
          .concat([
            boundedErrors(
              Type.Omit(projected, Object.keys(parameters.properties), {
                additionalProperties: false,
              }),
              Object.fromEntries(
                Object.entries(prepared).filter(
                  ([key]) => !Object.hasOwn(parameters.properties, key),
                ),
              ),
            ),
          ])
      : [boundedErrors(projected, prepared)];
  return {
    issues: combineIssues([
      ...retained,
      ...batches.flatMap((batch) => aggregateErrors(batch.errors, prepared)),
    ]),
    limited: batches.some((batch) => batch.limited),
  };
}

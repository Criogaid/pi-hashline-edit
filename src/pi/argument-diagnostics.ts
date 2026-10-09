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

export type { ArgumentIssue } from "../core/report-schema.ts";
import type { ArgumentIssue } from "../core/report-schema.ts";
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
      // Distinct property presence can disambiguate branches sharing a tag even
      // when common fields are missing or field values are invalid. Only choose
      // a branch here; its original constraints still supply the diagnostics.
      const knownFields = new Set(matches.flatMap((branch) => Object.keys(branch.properties)));
      const shapeValue = Object.fromEntries(
        Object.entries(value).filter(([field]) => knownFields.has(field)),
      );
      const shapes = matches.filter((branch) =>
        Value.Check(
          Type.Object(
            Object.fromEntries(
              Object.entries(branch.properties).map(([field, child]) => [
                field,
                IsOptional(child) ||
                matches.every((other) => Object.hasOwn(other.properties, field))
                  ? Type.Optional(Type.Unknown())
                  : Type.Unknown(),
              ]),
            ),
            ObjectOptions(branch),
          ),
          shapeValue,
        ),
      );
      if (shapes.length === 1) return projectSchema(shapes[0], value, path, explained, applicable);
      // A shared tag can select several shapes (for example before/after destinations).
      // Project every applicable branch so semantic checks are retained, then let the
      // native engine select a shape after already-explained constraints are removed.
      const projected = matches.map((branch) =>
        projectSchema(branch, value, path, explained, applicable),
      );
      const accepted = projected.filter((branch) => Value.Check(branch, value));
      return accepted.length === 1 ? accepted[0] : Type.Union(projected);
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
  const fields = new Map<string, { facts: Set<string>; fixes: Set<string> }>();
  for (const { field, fact, fix } of issues) {
    const entry = fields.get(field) ?? { facts: new Set<string>(), fixes: new Set<string>() };
    entry.facts.add(fact);
    if (fix !== undefined) entry.fixes.add(fix);
    fields.set(field, entry);
  }
  return [...fields].map(([field, entry]) => ({
    field,
    fact: [...entry.facts].join("; "),
    ...(entry.fixes.size ? { fix: [...entry.fixes].join(" ") } : {}),
  }));
}

function aggregateErrors(
  errors: readonly TLocalizedValidationError[],
  prepared: unknown,
): readonly ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  const add = (field: string, fact: string) => issues.push({ field, fact });
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

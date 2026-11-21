/** Failure-only schema projection and structured error aggregation; Pi owns input preparation and acceptance. */
import type { ValidationError } from "@earendil-works/pi-schema";
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
} from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { ArgumentIssue } from "./report-schema.ts";

interface ArgumentDiagnostics {
  readonly issues: readonly ArgumentIssue[];
  readonly limited: boolean;
}

/** State shared by one failure projection. */
interface Projection {
  /** Fields a tool check already explained; their schema constraints are dropped, except an object's fields'. */
  readonly explained: ReadonlySet<string>;
  /** Fields that belong to the projected shapes; a declared field belongs even when absent. */
  readonly applicable: Set<string>;
  /** Each object path's declared shape. */
  readonly objects: Map<string, TObject>;
}

function literalValues(schema: TSchema): readonly TLiteralValue[] | undefined {
  if (IsLiteral(schema)) return [schema.const];
  if (!IsUnion(schema)) return undefined;
  const values = schema.anyOf.map(literalValues);
  const choices = values.filter((value) => value !== undefined);
  return choices.length === values.length ? choices.flat() : undefined;
}

function projectSchema(
  schema: TSchema,
  value: unknown,
  path: string,
  projection: Projection,
): TSchema {
  const projected = projectValueSchema(schema, value, path, projection);
  return IsOptional(schema) && !IsOptional(projected) ? Type.Optional(projected) : projected;
}

function projectValueSchema(
  schema: TSchema,
  value: unknown,
  path: string,
  projection: Projection,
): TSchema {
  if (IsUnion(schema)) {
    const choices = literalValues(schema);
    if (choices) {
      projection.applicable.add(path);
      return Type.Unknown({ enum: [...new Set(choices)] });
    }
    return schema;
  }
  // A field can be forbidden by the operation regardless of its value's type.
  if (!IsObject(schema) && projection.explained.has(path)) {
    projection.applicable.add(path);
    return Type.Unknown();
  }
  if ("type" in schema && !Value.Check(Type.Unknown({ type: schema.type }), value)) return schema;
  projection.applicable.add(path);
  // An issue on a whole object, such as a choice between its fields, explains
  // none of the object's own constraints; its fields keep their diagnostics.
  if (IsObject(schema) && typeof value === "object" && value !== null) {
    projection.objects.set(path, schema);
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => {
        const field = propertyPath(path, key);
        // A tool check may require a field the schema leaves optional.
        if (!Object.hasOwn(value, key)) projection.applicable.add(field);
        return [key, projectSchema(child, Reflect.get(value, key), field, projection)];
      }),
    );
    return Type.Object(properties, ObjectOptions(schema));
  }
  if (IsArray(schema) && Array.isArray(value)) {
    const items = value.map((item, index) =>
      projectSchema(schema.items, item, `${path}[${index}]`, projection),
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

/** Declared tool fields do not contain slashes or tildes. TypeBox emits unknown keys verbatim. */
function pointerParts(pointer: string): readonly string[] {
  return pointer.split("/").slice(1);
}

function valuePath(parts: readonly string[], prepared: unknown): string {
  let value = prepared;
  let path = "";
  for (const part of parts) {
    path = Array.isArray(value) ? `${path}[${part}]` : propertyPath(path, part);
    value = typeof value === "object" && value !== null ? Reflect.get(value, part) : undefined;
  }
  return path;
}

/** Pi escapes JSON Pointer keys. TypeBox passes additional keys verbatim in its own diagnostics. */
export function nativeArgumentIssue(error: ValidationError, prepared: unknown): ArgumentIssue {
  const parts = pointerParts(error.path).map((key) =>
    key.replaceAll("~1", "/").replaceAll("~0", "~"),
  );
  return { field: valuePath(parts, prepared) || "$", reason: error.message };
}

/** One declaration's meaning: its description, labeled with its values when it is a choice. */
function explainDeclaration(schema: TSchema): string | undefined {
  const description: unknown = Reflect.get(schema, "description");
  const values = literalValues(schema);
  if (values === undefined) return typeof description === "string" ? description : undefined;
  if (typeof description === "string")
    return `${values.map((value) => JSON.stringify(value)).join(" or ")}: ${description}`;
  if (!IsUnion(schema)) return undefined;
  const choices = schema.anyOf.map(explainDeclaration);
  return choices.every((choice) => choice !== undefined) ? choices.join(" ") : undefined;
}

/**
 * What the field at `parts` does, from its declaration. An array item without
 * its own description is explained by its array.
 */
function fieldExplanation(schema: TSchema, parts: readonly string[]): string | undefined {
  if (parts.length === 0) return explainDeclaration(schema);
  const [part, ...rest] = parts;
  if (IsObject(schema))
    return Object.hasOwn(schema.properties, part)
      ? fieldExplanation(schema.properties[part], rest)
      : undefined;
  if (!IsArray(schema)) return undefined;
  const item = fieldExplanation(schema.items, rest);
  return item ?? (rest.length === 0 ? explainDeclaration(schema) : undefined);
}

/** Why a field is not allowed: the fields its object declares. */
function shapeExplanation(object: TObject | undefined): string | undefined {
  return object && `Accepted fields: ${Object.keys(object.properties).join(", ")}.`;
}

/** One issue per field: distinct reasons joined, and distinct fixes joined, each in report order. */
function combineIssues(issues: readonly ArgumentIssue[]): readonly ArgumentIssue[] {
  const fields = new Map<string, { reasons: Set<string>; fixes: Set<string> }>();
  for (const { field, reason, fix } of issues) {
    const existing = fields.get(field) ?? { reasons: new Set<string>(), fixes: new Set<string>() };
    existing.reasons.add(reason);
    if (fix !== undefined) existing.fixes.add(fix);
    fields.set(field, existing);
  }
  return [...fields].map(([field, { reasons, fixes }]) => ({
    field,
    reason: [...reasons].join("; "),
    ...(fixes.size ? { fix: [...fixes].join(" ") } : {}),
  }));
}

/**
 * One issue per native error. Reasons that do not say how to correct the value
 * carry a fix derived from the declared schema: a missing field, a pattern
 * mismatch, and a value outside the field's choices explain the field, and a
 * field that is not allowed lists its object's declared fields.
 */
function aggregateErrors(
  errors: readonly TLocalizedValidationError[],
  parameters: TObject,
  prepared: unknown,
  objects: ReadonlyMap<string, TObject>,
): readonly ArgumentIssue[] {
  const issues = errors.flatMap((error): ArgumentIssue[] => {
    const parts = pointerParts(error.instancePath);
    switch (error.keyword) {
      case "required": {
        const parent = valuePath(parts, prepared);
        return error.params.requiredProperties.map((key) =>
          argumentIssue(
            propertyPath(parent, key),
            "is required",
            fieldExplanation(parameters, [...parts, key]),
          ),
        );
      }
      case "additionalProperties":
        return undeclaredIssues(valuePath(parts, prepared), error.params.additionalProperties);
      case "boolean": {
        // TypeBox emits a false-schema error per unknown key before its grouped error.
        // Count declared path steps to preserve the entire unknown key, even if it contains '/'.
        const depth = error.schemaPath
          .split("/")
          .filter(
            (segment) =>
              segment === "properties" || segment === "items" || segment === "prefixItems",
          ).length;
        return undeclaredIssues(valuePath(parts.slice(0, depth), prepared), [
          parts.slice(depth).join("/"),
        ]);
      }
      case "pattern":
      case "enum": {
        const reason =
          error.keyword === "enum"
            ? `expected one of: ${error.params.allowedValues.map((value) => JSON.stringify(value)).join(", ")}`
            : error.message;
        return [
          argumentIssue(
            valuePath(parts, prepared) || "$",
            reason,
            fieldExplanation(parameters, parts),
          ),
        ];
      }
      default:
        return [{ field: valuePath(parts, prepared) || "$", reason: error.message }];
    }
  });
  return combineIssues(issues);

  function undeclaredIssues(parent: string, keys: readonly string[]): ArgumentIssue[] {
    const fix = shapeExplanation(objects.get(parent));
    return keys.map((key) => argumentIssue(propertyPath(parent, key), "is not allowed", fix));
  }

  function argumentIssue(field: string, reason: string, fix: string | undefined): ArgumentIssue {
    return fix === undefined ? { field, reason } : { field, reason, fix };
  }
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
  // On schema success every path reported by a tool check is applicable.
  if (!schemaFailed) return { issues: combineIssues(semanticIssues), limited: false };

  const projection: Projection = {
    explained: new Set(semanticIssues.map((issue) => issue.field)),
    applicable: new Set<string>(),
    objects: new Map(),
  };
  const projected = projectSchema(parameters, prepared, "", projection);
  const retained = combineIssues(
    semanticIssues.filter((issue) => projection.applicable.has(issue.field)),
  );
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
      ...batches.flatMap((batch) =>
        aggregateErrors(batch.errors, parameters, prepared, projection.objects),
      ),
    ]),
    limited: batches.some((batch) => batch.limited),
  };
}

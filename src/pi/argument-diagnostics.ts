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
import type { ArgumentIssue } from "./report-schema.ts";

export interface ArgumentDiagnostics {
  readonly issues: readonly ArgumentIssue[];
  readonly limited: boolean;
}

/** The declared object a value was projected with, and the tag field that selected it among branches. */
interface SelectedShape {
  readonly object: TObject;
  readonly tag?: string;
}

/** State shared by one failure projection. */
interface Projection {
  /** Fields a tool check already explained; their schema constraints are dropped. */
  readonly explained: ReadonlySet<string>;
  /** Fields that belong to the selected shapes. */
  readonly applicable: Set<string>;
  /** Branch constraints that native diagnostics would split across branches. */
  readonly derived: ArgumentIssue[];
  /** Each object path's selected shape; paths left to several branches are absent. */
  readonly selected: Map<string, SelectedShape>;
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

/**
 * Fields that alone tell tag-sharing branches apart: each branch requires one
 * field that every other branch forbids, and shares all others unchanged.
 * Shared fields are compared by schema identity, so branches must reuse one
 * instance per field; otherwise the general union projection applies.
 */
function exclusiveFields(branches: readonly TObject[]): readonly string[] | undefined {
  const fields = branches.map((branch) => {
    const own = Object.keys(branch.properties).filter((field) =>
      branches.some((other) => other.properties[field] !== branch.properties[field]),
    );
    return own.length === 1 &&
      branch.required?.includes(own[0]) &&
      ObjectOptions(branch).additionalProperties === false
      ? own[0]
      : undefined;
  });
  return fields.every((field): field is string => field !== undefined) &&
    new Set(fields).size === fields.length
    ? fields
    : undefined;
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
    const tag = objectTag(schema);
    if (tag) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return Type.Unknown({ type: "object" });
      const select = (branch: TObject): TSchema => {
        const projected = projectSchema(branch, value, path, projection);
        projection.selected.set(path, { object: branch, tag: tag.field });
        return projected;
      };
      const matches = tag.branches.filter((branch) =>
        Value.Check(branch.properties[tag.field], Reflect.get(value, tag.field)),
      );
      if (matches.length === 1) return select(matches[0]);
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
      if (shapes.length === 1) return select(shapes[0]);
      // Branches set apart only by exclusive fields (for example before/after
      // destinations) fail together when none or several are given. Validate their
      // merged shape once and state the choice as one issue, instead of each branch
      // requiring its own field and forbidding the others.
      const alternatives = exclusiveFields(matches);
      if (alternatives) {
        const given = alternatives.filter((field) => Object.hasOwn(value, field));
        if (given.length !== 1)
          projection.derived.push({
            field: path || "$",
            reason: `expected exactly one of: ${alternatives.join(", ")}`,
          });
        const merged = Type.Object(
          Object.fromEntries(
            matches
              .flatMap((branch) => Object.entries(branch.properties))
              .map(([field, child]) => [
                field,
                alternatives.includes(field) ? Type.Optional(child) : child,
              ]),
          ),
          ObjectOptions(matches[0]),
        );
        return select(merged);
      }
      // Otherwise project every applicable branch so semantic checks are retained, then
      // let the native engine select a shape after already-explained constraints are removed.
      const projected = matches.map((branch) => projectSchema(branch, value, path, projection));
      projection.selected.delete(path);
      const accepted = projected.filter((branch) => Value.Check(branch, value));
      return accepted.length === 1 ? accepted[0] : Type.Union(projected);
    }
    const typed = schema.anyOf.filter((branch) => "type" in branch);
    if (typed.length === schema.anyOf.length) {
      const matches = typed.filter(
        (branch) => "type" in branch && Value.Check(Type.Unknown({ type: branch.type }), value),
      );
      if (matches.length === 1) return projectSchema(matches[0], value, path, projection);
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
  projection.applicable.add(path);
  if (projection.explained.has(path)) return Type.Unknown();
  if (IsObject(schema) && typeof value === "object" && value !== null) {
    projection.selected.set(path, { object: schema });
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        projectSchema(child, Reflect.get(value, key), propertyPath(path, key), projection),
      ]),
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

const unescapePointer = (part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~");

function pointerParts(pointer: string): readonly string[] {
  return pointer.split("/").slice(1).map(unescapePointer);
}

/**
 * The projection path of the value at `pointer`; the root is "". Pi's TypeBox leaves `/` and
 * `~` in property names unescaped, so a name spans the fewest segments that form an own key,
 * read escaped or as is.
 */
function valuePath(pointer: string, prepared: unknown): string {
  const segments = pointer.split("/").slice(1);
  let value = prepared;
  let path = "";
  for (let index = 0; index < segments.length; index++) {
    let part = unescapePointer(segments[index]);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const object = value;
      for (let end = index + 1; end <= segments.length; end++) {
        const raw = segments.slice(index, end).join("/");
        const key = [unescapePointer(raw), raw].find((name) => Object.hasOwn(object, name));
        if (key !== undefined) {
          part = key;
          index = end - 1;
          break;
        }
      }
    }
    path = Array.isArray(value) ? `${path}[${part}]` : propertyPath(path, part);
    value = typeof value === "object" && value !== null ? Reflect.get(value, part) : undefined;
  }
  return path;
}

function fieldPath(pointer: string, prepared: unknown, key?: string): string {
  const path = valuePath(pointer, prepared);
  return (key === undefined ? path : propertyPath(path, key)) || "$";
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
 * What the field at `parts` does, from its declarations in every branch.
 * Choices label each value, so every branch's choices are listed together;
 * other declarations must agree, so one branch's description is never
 * attributed to another. An array item without its own description is
 * explained by its array.
 */
function fieldExplanation(schema: TSchema, parts: readonly string[]): string | undefined {
  const declarations = new Set<TSchema>();
  const visit = (node: TSchema, depth: number): void => {
    if (depth === parts.length) declarations.add(node);
    else if (IsUnion(node)) for (const branch of node.anyOf) visit(branch, depth);
    else if (IsObject(node)) {
      if (Object.hasOwn(node.properties, parts[depth]))
        visit(node.properties[parts[depth]], depth + 1);
    } else if (IsArray(node))
      visit(
        depth + 1 === parts.length && explainDeclaration(node.items) === undefined
          ? node
          : node.items,
        depth + 1,
      );
  };
  visit(schema, 0);
  if (declarations.size === 0) return undefined;
  const explanations = new Set([...declarations].map(explainDeclaration));
  if (explanations.has(undefined)) return undefined;
  const choices = [...declarations].every(
    (declaration) => literalValues(declaration) !== undefined,
  );
  return choices || explanations.size === 1 ? [...explanations].join(" ") : undefined;
}

/** Why a field is not allowed: the fields the selected shape declares, after the meaning of the tag that chose it. */
function shapeExplanation({ object, tag }: SelectedShape): string {
  const fields = `Accepted fields: ${Object.keys(object.properties).join(", ")}.`;
  const choice = tag === undefined ? undefined : explainDeclaration(object.properties[tag]);
  return choice === undefined ? fields : `${choice} ${fields}`;
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
 * carry a fix derived from the declared schema: a missing field and a pattern
 * mismatch explain the field, and a field that is not allowed explains its
 * selected shape.
 */
function aggregateErrors(
  errors: readonly TLocalizedValidationError[],
  parameters: TObject,
  prepared: unknown,
  selected: ReadonlyMap<string, SelectedShape>,
): readonly ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  const add = (field: string, reason: string, fix?: string) =>
    issues.push(fix === undefined ? { field, reason } : { field, reason, fix });
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
      case "required": {
        const parts = pointerParts(error.instancePath);
        for (const key of error.params.requiredProperties)
          add(
            fieldPath(error.instancePath, prepared, key),
            "is required",
            fieldExplanation(parameters, [...parts, key]),
          );
        break;
      }
      case "additionalProperties": {
        const shape = selected.get(valuePath(error.instancePath, prepared));
        const fix = shape && shapeExplanation(shape);
        for (const key of error.params.additionalProperties)
          add(fieldPath(error.instancePath, prepared, key), "is not allowed", fix);
        break;
      }
      case "pattern":
        add(
          fieldPath(error.instancePath, prepared),
          error.message,
          fieldExplanation(parameters, pointerParts(error.instancePath)),
        );
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
  const projection: Projection = {
    explained: new Set(semanticIssues.map((issue) => issue.field)),
    applicable: new Set<string>(),
    derived: [],
    selected: new Map(),
  };
  const projected = projectSchema(parameters, prepared, "", projection);
  const retained = combineIssues(
    semanticIssues.filter((issue) => projection.applicable.has(issue.field)),
  );
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
      ...projection.derived,
      ...batches.flatMap((batch) =>
        aggregateErrors(batch.errors, parameters, prepared, projection.selected),
      ),
    ]),
    limited: batches.some((batch) => batch.limited),
  };
}

/**
 * Shared tool argument boundary. Prepare with Pi's schema engine so semantic
 * checks and bounded diagnostics see the same coerced value, including on
 * schema failure. Pi coerces and validates the same observed snapshot.
 * Tool schemas have no cross-field constraints.
 */
import { resolve } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { IsArray, IsObject, type Static, type TObject, type TSchema } from "typebox";
import { errorMessage } from "../core/errors.ts";
import { buildRegex } from "../core/regex.ts";
import { diagnoseArguments, nativeArgumentIssue, propertyPath } from "./argument-diagnostics.ts";
import { formatArgumentError } from "./argument-error.ts";
import type { OutputBudgetProvider } from "./budgets.ts";
import { parseArgumentPath, type ResolvedArgumentPath } from "./path.ts";
import type { ArgumentIssue } from "./report-schema.ts";

/** Report one semantic issue: what is wrong (a fact), and how to correct it when the fact alone does not say. */
export type ReportArgumentIssue = (field: string, reason: string, fix?: string) => void;
export type CheckArguments<Parsed> = (args: unknown, report: ReportArgumentIssue) => () => Parsed;

export const noArgumentProduct = () => {};

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

/** pi-ai's validateToolArguments compile options. */
const COMPILE_OPTIONS = { formats, coerce: true, unresolvedRefs: "reject" } as const;

/**
 * Pi hands renderers a call's raw arguments, also while they stream, and coerces them only for
 * execution. Renderers receive the same coercion on a copy, so a card shows the call that ran;
 * arguments that cannot be coerced stay raw.
 */
export function createRenderArguments(parameters: TSchema): (args: unknown) => unknown {
  const validator = compile(parameters, COMPILE_OPTIONS);
  return (args) => {
    try {
      return validator.coerce(structuredClone(args));
    } catch {
      return args;
    }
  };
}

function parsePathArguments(args: unknown, report: ReportArgumentIssue) {
  const path = (args as { path?: unknown } | null)?.path;
  const locals: { spelling: string; local: string }[] = [];
  const parse = (spelling: unknown, field: string) => {
    if (typeof spelling !== "string") return;
    try {
      locals.push({ spelling, local: parseArgumentPath(spelling) });
    } catch (error) {
      report(field, errorMessage(error));
    }
  };
  if (Array.isArray(path)) path.forEach((spelling, index) => parse(spelling, `path[${index}]`));
  else parse(path, "path");
  return locals;
}

function arrayShapeIssue(
  array: readonly unknown[],
  path: string,
  items?: TSchema,
): ArgumentIssue | undefined {
  const keys = Object.keys(array);
  // A clone's own indices are dense if their count and last index agree with length.
  if (
    keys.length !== array.length ||
    (keys.length !== 0 && keys.at(-1) !== String(array.length - 1))
  ) {
    // Indexed keys precede named keys. Their first mismatch locates the first hole.
    const mismatch = keys.findIndex((key, index) => key !== String(index));
    const index = mismatch === -1 ? keys.length : mismatch;
    if (index < array.length)
      return { field: `${path}[${index}]`, reason: "is required; arrays must not have holes" };
    return { field: propertyPath(path, keys[index]), reason: "is not allowed on an array" };
  }

  if (!IsArray(items) && !IsObject(items)) return undefined;
  for (const [index, item] of array.entries()) {
    const issue = firstArrayIssue(items, item, `${path}[${index}]`);
    if (issue) return issue;
  }
  return undefined;
}

/**
 * Follow declared fields only, so a hook's cyclic object graph cannot drive recursion.
 * Pi wraps a singleton by its item schema, so the singleton is checked there at the caller's path.
 */
function firstArrayIssue(schema: TSchema, value: unknown, path = ""): ArgumentIssue | undefined {
  if (!(value instanceof Object)) return undefined;
  if (IsArray(schema))
    return Array.isArray(value)
      ? arrayShapeIssue(value, path, schema.items)
      : firstArrayIssue(schema.items, value, path);
  if (Array.isArray(value)) return arrayShapeIssue(value, path);
  if (!IsObject(schema)) return undefined;
  for (const [key, child] of Object.entries(schema.properties)) {
    const issue = firstArrayIssue(child, Reflect.get(value, key), propertyPath(path, key));
    if (issue) return issue;
  }
  return undefined;
}

function withArgumentError<Value>(
  operation: () => Value,
  budgets: OutputBudgetProvider,
  field = "$",
): Value {
  try {
    return operation();
  } catch (error) {
    throw new Error(
      formatArgumentError([{ field, reason: errorMessage(error) }], false, budgets()),
      { cause: error },
    );
  }
}

/** Snapshot enumerable call data under the diagnostic budget of the owning operation. */
export function cloneArguments<Value>(
  args: Value,
  budgets: OutputBudgetProvider,
  field = "$",
): Value {
  return withArgumentError(() => structuredClone(args), budgets, field);
}

export function createArgumentBoundary<T extends TObject, Parsed>(
  parameters: T,
  cwd: string,
  budgets: OutputBudgetProvider,
  check: CheckArguments<Parsed>,
) {
  const validator = compile(parameters, COMPILE_OPTIONS);

  function snapshot<Value>(args: Value): Value {
    const copy = cloneArguments(args, budgets);
    const issue = firstArrayIssue(parameters, copy);
    if (issue) throw new Error(formatArgumentError([issue], false, budgets()));
    return copy;
  }

  function verdict(checked: unknown) {
    const schemaFailed = !withArgumentError(() => validator.check(checked), budgets);
    const issues: ArgumentIssue[] = [];
    const report: ReportArgumentIssue = (field, reason, fix) => {
      issues.push(fix === undefined ? { field, reason } : { field, reason, fix });
    };
    const build = check(checked, report);
    const locals = parsePathArguments(checked, report);
    if (!schemaFailed && issues.length === 0) return { build, locals };

    const result = diagnoseArguments(parameters, checked, issues, schemaFailed);
    // Pi can reject values that TypeBox does not diagnose, for example near-integers.
    const reasons =
      schemaFailed && result.issues.length === 0
        ? validator.errors(checked).map((error) => nativeArgumentIssue(error, checked))
        : result.issues;
    throw new Error(formatArgumentError(reasons, result.limited, budgets()));
  }

  return {
    prepareArguments(args: unknown): Static<T> {
      const raw = snapshot(args);
      verdict(withArgumentError(() => validator.coerce(raw), budgets));
      // Coercion is copy-on-write. Pi applies it to this snapshot before passing args to hooks.
      return raw as Static<T>;
    },
    // A tool_call hook can retain and mutate the validated arguments before or during execution.
    // The tool consumes its own checked snapshot of the canonical arguments the last hook left.
    afterHooks(args: unknown) {
      const checked = snapshot(args);
      const { build, locals } = verdict(checked);
      const paths: ResolvedArgumentPath[] = locals.map(({ spelling, local }) => ({
        absolutePath: resolve(cwd, local),
        spelling,
      }));
      // The schema and semantic checks above validate this owned execution snapshot.
      return { args: checked as Static<T>, parsed: build(), paths };
    },
  };
}

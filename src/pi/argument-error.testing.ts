import assert from "node:assert/strict";
import type { ArgumentIssue, Report } from "./report-schema.ts";

type ArgumentRejection = Omit<Report, "tool" | "path"> & {
  error: "INVALID_ARGUMENTS";
  issues: ArgumentIssue[];
};

/** Assert the model-facing JSON contract before inspecting an individual rejection. */
export function argumentError(error: unknown): ArgumentRejection {
  assert.ok(error instanceof Error);
  const value: unknown = JSON.parse(error.message);
  assert.ok(typeof value === "object" && value !== null);
  assert.equal(Reflect.get(value, "error"), "INVALID_ARGUMENTS");
  assert.equal(Object.hasOwn(value, "tool"), false);
  assert.equal(Object.hasOwn(value, "path"), false);
  const issues: unknown = Reflect.get(value, "issues");
  assert.ok(Array.isArray(issues));
  for (const issue of issues) {
    assert.ok(typeof issue === "object" && issue !== null);
    assert.equal(typeof Reflect.get(issue, "field"), "string");
    assert.equal(typeof Reflect.get(issue, "reason"), "string");
  }
  // The assertions above establish the output boundary's required fields.
  return value as ArgumentRejection;
}

/** Match a precise field and caller-relevant reason, independent of JSON layout. */
export function rejectsArgument(field: string, reason: RegExp = /./) {
  return (error: unknown): boolean => {
    const result = argumentError(error);
    assert.ok(
      result.issues.some((issue) => issue.field === field && reason.test(issue.reason)),
      JSON.stringify(result),
    );
    return true;
  };
}

export function rejectsArguments() {
  return (error: unknown): boolean => {
    const result = argumentError(error);
    assert.ok(result.issues.length > 0);
    return true;
  };
}

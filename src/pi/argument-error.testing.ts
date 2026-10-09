import assert from "node:assert/strict";
import type { ArgumentError } from "./argument-error.ts";

/** Assert the model-facing JSON contract before inspecting an individual rejection. */
export function argumentError(error: unknown): ArgumentError {
  assert.ok(error instanceof Error);
  const value: unknown = JSON.parse(error.message);
  assert.ok(typeof value === "object" && value !== null);
  assert.equal(Reflect.get(value, "error"), "INVALID_ARGUMENTS");
  assert.equal(typeof Reflect.get(value, "tool"), "string");
  assert.equal(Reflect.get(value, "executed"), false);
  const issues: unknown = Reflect.get(value, "issues");
  assert.ok(Array.isArray(issues));
  for (const issue of issues) {
    assert.ok(typeof issue === "object" && issue !== null);
    assert.equal(typeof Reflect.get(issue, "field"), "string");
    assert.equal(typeof Reflect.get(issue, "reason"), "string");
  }
  // The assertions above establish the output boundary's required fields.
  return value as ArgumentError;
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

export function rejectsArguments(tool: string) {
  return (error: unknown): boolean => {
    const result = argumentError(error);
    assert.equal(result.tool, tool);
    assert.ok(result.issues.length > 0);
    return true;
  };
}

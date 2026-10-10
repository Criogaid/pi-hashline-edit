import assert from "node:assert/strict";
import { test } from "node:test";
import { HashlineError } from "./errors.ts";

// npm run typecheck checks these invalid callers; they must never run.
function invalidErrorConstruction() {
  // @ts-expect-error NO_MATCH requires its rule fact.
  new HashlineError("NO_MATCH", "missing");
  // @ts-expect-error NO_MATCH facts cannot contain unrelated fields.
  new HashlineError("NO_MATCH", "missing", { facts: { rule: 0, ids: [] } });
  // @ts-expect-error TARGET_EXISTS has no code facts.
  new HashlineError("TARGET_EXISTS", "exists", { facts: { rule: 0 } });
  // @ts-expect-error Only PATH_NOT_FOUND permits useCreate recovery.
  new HashlineError("NO_MATCH", "missing", { facts: { rule: 0 }, next: "useCreate" });
}

test("classified code with required facts → retains facts and native cause", () => {
  const cause = new Error("native failure");
  const failure = new HashlineError("NO_MATCH", "missing", { facts: { rule: 2 }, cause });
  assert.equal(failure.errorCode, "NO_MATCH");
  assert.deepEqual(failure.facts, { rule: 2 });
  assert.equal(failure.cause, cause);
});

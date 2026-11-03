import assert from "node:assert/strict";
import { test } from "node:test";
import { filesystemErrorCode, HashlineError, PATH_ERROR_MESSAGES } from "./errors.ts";

// npm run typecheck checks these invalid callers; they must never run.
function invalidErrorConstruction() {
  // @ts-expect-error NO_MATCH requires its unmatched fact.
  new HashlineError("NO_MATCH", "missing");
  // @ts-expect-error NO_MATCH facts cannot contain unrelated fields.
  new HashlineError("NO_MATCH", "missing", { facts: { unmatched: [], ids: [] } });
  // @ts-expect-error TARGET_EXISTS has no code facts.
  new HashlineError("TARGET_EXISTS", "exists", { facts: { unmatched: [] } });
  // @ts-expect-error Only PATH_NOT_FOUND permits useCreate recovery.
  new HashlineError("NO_MATCH", "missing", { facts: { unmatched: [] }, next: "useCreate" });
}

test("classified code with required facts → retains facts and native cause", () => {
  const cause = new Error("native failure");
  const failure = new HashlineError("NO_MATCH", "missing", {
    facts: { unmatched: ["replacements[2]"] },
    cause,
  });
  assert.equal(failure.errorCode, "NO_MATCH");
  assert.deepEqual(failure.facts, { unmatched: ["replacements[2]"] });
  assert.equal(failure.cause, cause);
});

test("filesystem errors → classify missing paths and directories consistently", () => {
  assert.equal(PATH_ERROR_MESSAGES.PATH_NOT_FOUND, "Path not found.");
  assert.equal(PATH_ERROR_MESSAGES.NOT_REGULAR_FILE, "Path is not a regular file.");
  for (const [code, expected] of [
    ["ENOENT", "PATH_NOT_FOUND"],
    ["EISDIR", "NOT_REGULAR_FILE"],
    ["EPERM", "FILESYSTEM_ERROR"],
  ] as const) {
    assert.equal(filesystemErrorCode({ code }), expected);
  }
  assert.equal(filesystemErrorCode(new Error()), undefined);
});

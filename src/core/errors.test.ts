import assert from "node:assert/strict";
import { test } from "node:test";
import {
  errnoCode,
  errorMessage,
  filesystemErrorCode,
  HashlineError,
  NO_STRING_FORM,
  PATH_ERROR_MESSAGES,
} from "./errors.ts";

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

test("thrown value without a string form → returns a diagnostic", () => {
  assert.equal(errorMessage(Object.create(null)), "The thrown value has no string form.");
});

test("error with a numeric message → returns its diagnostic as text", () => {
  assert.equal(errorMessage(Object.assign(new Error(), { message: 17 })), "17");
});

test("revoked proxy as a thrown value → returns a diagnostic", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(errorMessage(proxy), NO_STRING_FORM);
});

test("throwing errno getter → returns no code", () => {
  const error = Object.defineProperty(new Error(), "code", {
    get() {
      throw new Error("Cannot read errno");
    },
  });
  assert.equal(errnoCode(error), undefined);
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

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { HashlineError } from "../core/errors.ts";
import { runRegexReplacements } from "../pi/replace-regex.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "../pi/budgets.ts";
import { causeOf } from "../pi/report.ts";
import type { Cause } from "../pi/report-schema.ts";

const timeoutMs = 10_000;
const validRules = [{ find: "safe", replace: "changed", literal: false }];

test("worker boundary: malformed external reply → rejects its result and facts", async (t) => {
  for (const reply of [
    { result: { text: 123, count: 1 } },
    { result: { text: "changed", count: 0 } },
    {
      result: { text: "changed", count: 1 },
      error: { code: "NO_MATCH", message: "failure", facts: { rule: 0 } },
    },
    { error: { code: "NO_MATCH", message: "failure" } },
    { error: { code: "foreign", message: "failure" } },
    { error: { code: "NO_MATCH", message: "failure", facts: { rule: 0, foreign: true } } },
  ]) {
    await t.test(JSON.stringify(reply), { timeout: timeoutMs }, async (t) => {
      const emit = Worker.prototype.emit;
      t.mock.method(
        Worker.prototype,
        "emit",
        function (this: Worker, event: string | symbol, ...args: unknown[]) {
          return emit.call(this, event, ...(event === "message" ? [reply] : args));
        },
      );
      await assert.rejects(
        runRegexReplacements("safe", validRules, timeoutMs, undefined),
        (error: unknown) =>
          error instanceof HashlineError &&
          error.errorCode === "REGEX_WORKER_FAILED" &&
          /invalid result/i.test(error.message),
      );
    });
  }
});

test("worker boundary: deep structured cause reply → preserves the terminal cause and every branch", {
  timeout: timeoutMs,
}, async (t) => {
  let nested: Cause = { code: "EACCES", message: "permission denied" };
  for (let index = 0; index < 12; index++)
    nested = { code: "EIO", message: `layer ${index}`, cause: nested };
  const cause: Cause = {
    message: "worker failure",
    cause: nested,
    errors: Array.from({ length: 24 }, (_, index) => ({
      code: "EIO",
      message: `branch ${index}`,
    })),
  };
  const emit = Worker.prototype.emit;
  t.mock.method(
    Worker.prototype,
    "emit",
    function (this: Worker, event: string | symbol, ...args: unknown[]) {
      return emit.call(
        this,
        event,
        ...(event === "message"
          ? [{ error: { code: "REGEX_WORKER_FAILED", message: "Regex evaluation failed.", cause } }]
          : args),
      );
    },
  );
  await assert.rejects(
    runRegexReplacements("safe", validRules, timeoutMs, undefined),
    (error: unknown) => {
      assert.ok(error instanceof HashlineError);
      assert.equal(error.errorCode, "REGEX_WORKER_FAILED");
      assert.deepEqual(causeOf(error.cause, DEFAULT_OUTPUT_BUDGETS.fieldBytes), cause);
      return true;
    },
  );
});

test("worker boundary: cyclic structured cause → rejects a reply accepted with an acyclic cause", {
  timeout: timeoutMs,
}, async (t) => {
  for (const cyclic of [false, true]) {
    await t.test(`cyclic=${cyclic}`, async (t) => {
      const cause: Cause = { code: "EIO", message: "worker failure" };
      if (cyclic) cause.cause = cause;
      const reply = { error: { code: "NO_MATCH", message: "no match", facts: { rule: 0 }, cause } };
      const emit = Worker.prototype.emit;
      t.mock.method(
        Worker.prototype,
        "emit",
        function (this: Worker, event: string | symbol, ...args: unknown[]) {
          return emit.call(this, event, ...(event === "message" ? [reply] : args));
        },
      );
      await assert.rejects(
        runRegexReplacements("safe", validRules, timeoutMs, undefined),
        (error: unknown) => {
          assert.ok(error instanceof HashlineError);
          if (cyclic) {
            assert.equal(error.errorCode, "REGEX_WORKER_FAILED");
            assert.match(error.message, /invalid result/i);
          } else {
            assert.equal(error.errorCode, "NO_MATCH");
            assert.deepEqual(error.facts, { rule: 0 });
            assert.deepEqual(causeOf(error.cause, DEFAULT_OUTPUT_BUDGETS.fieldBytes), cause);
          }
          return true;
        },
      );
    });
  }
});

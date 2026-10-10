import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { HashlineError } from "../core/errors.ts";
import { runRegexReplacements } from "../pi/replace-regex.ts";
import { causeOf } from "../pi/report.ts";

const timeoutMs = 10_000;
const validRules = [{ find: "safe", replace: "changed", regex: true }];

test("worker boundary: invalid incoming data → rejects before replacement", async (t) => {
  for (const workerData of [
    { source: "safe", rules: [] },
    { source: "safe", rules: [{ ...validRules[0], foreign: true }] },
    { source: "safe", rules: validRules, foreign: true },
  ]) {
    await t.test(JSON.stringify(workerData), { timeout: timeoutMs }, async (t) => {
      const worker = new Worker(new URL("../pi/replace-worker.mjs", import.meta.url), {
        workerData,
      });
      t.after(() => worker.terminate());
      try {
        const reply = await new Promise<unknown>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => reject(new Error(`Worker exited before reply: ${code}`)));
        });
        assert.ok(typeof reply === "object" && reply !== null && "error" in reply);
        const error = reply.error;
        assert.ok(typeof error === "object" && error !== null && "code" in error);
        assert.equal(error.code, "REGEX_WORKER_FAILED");
      } finally {
        await worker.terminate();
      }
    });
  }
});

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

test("worker boundary: structured cause reply → preserves codes, branches and omissions", {
  timeout: timeoutMs,
}, async (t) => {
  const cause = {
    code: "EACCES",
    message: "permission denied",
    cause: { error: "UNSUPPORTED_TEXT", message: "underlying content" },
    errors: [{ code: "EIO", message: "another failure" }],
    omitted: 3,
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
      assert.deepEqual(causeOf(error.cause), cause);
      return true;
    },
  );
});

test("worker boundary: cyclic argument facts in a reply → rejects nonserializable diagnostics", {
  timeout: timeoutMs,
}, async (t) => {
  const argumentsCopy: { self?: unknown } = {};
  argumentsCopy.self = argumentsCopy;
  const reply = {
    error: {
      code: "INVALID_ARGUMENTS",
      message: "invalid arguments",
      facts: { issues: [{ field: "path", reason: "missing" }], arguments: argumentsCopy },
    },
  };
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
    (error: unknown) => error instanceof HashlineError && error.errorCode === "REGEX_WORKER_FAILED",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRgSucceeded, matcherArgs } from "./rg-process.ts";
import { HashlineError } from "../core/errors.ts";

test("grep matcher arguments fix the engine, original-byte view, and case mode", () => {
  for (const engine of ["default", "pcre2"] as const) {
    for (const multiline of [false, true]) {
      const pattern = "--pattern";
      assert.deepEqual(matcherArgs({ engine, pattern, multiline }), [
        "--no-config",
        "--color=never",
        `--engine=${engine}`,
        "--crlf",
        multiline ? "--multiline" : "--no-multiline",
        "--case-sensitive",
        "--encoding=none",
        "-e",
        pattern,
      ]);
    }
  }
});

test("grep search exit status accepts no matches and preserves failure diagnostics", () => {
  for (const code of [0, 1]) assert.doesNotThrow(() => assertRgSucceeded({ code, stderr: "" }));
  assert.throws(
    () => assertRgSucceeded({ code: 2, stderr: "  regex parse error\n" }),
    (error: unknown) =>
      error instanceof HashlineError &&
      error.errorCode === "RIPGREP_FAILED" &&
      error.facts?.exitCode === 2 &&
      error.cause === "regex parse error",
  );
  assert.throws(
    () => assertRgSucceeded({ code: null, stderr: "" }),
    (error: unknown) =>
      error instanceof HashlineError &&
      error.errorCode === "RIPGREP_FAILED" &&
      error.facts?.exitCode === null,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRgSucceeded, candidateArgs, COMMON_RG_ARGS } from "./rg-process.ts";
import { HashlineError } from "../core/errors.ts";

test("candidate literals → rg lists files with escaped byte-preserving alternatives", () => {
  assert.deepEqual(candidateArgs({ kind: "all" }), [...COMMON_RG_ARGS, "--files"]);
  for (const [literals, pattern] of [
    [
      [
        [["a"], ["."], ["b"]],
        [["-"], ["é"]],
      ],
      "a\\x{2e}b|\\x{2d}\\x{e9}",
    ],
    [[[["K", "k", "K"], ["_"], ["9"]]], "[Kk\\x{212a}]_9"],
  ] as const) {
    assert.deepEqual(candidateArgs({ kind: "literals", literals }), [
      ...COMMON_RG_ARGS,
      "--files-with-matches",
      "--engine=default",
      "--case-sensitive",
      "--encoding=none",
      "-e",
      pattern,
    ]);
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

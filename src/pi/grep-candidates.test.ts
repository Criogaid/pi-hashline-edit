import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateArgs } from "./grep-candidates.ts";
import { COMMON_RG_ARGS } from "./rg-process.ts";

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

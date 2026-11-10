import { fileCandidateArgs } from "./grep-rg.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMON_RG_ARGS } from "./rg-process.ts";

test("candidate literals → rg lists files with escaped byte-preserving alternatives", async () => {
  const query = { patterns: ["."], literal: false, flags: "", multiline: true };
  assert.deepEqual(await fileCandidateArgs(query), [...COMMON_RG_ARGS, "--files"]);
  for (const [patterns, literal, flags, pattern] of [
    [["a.b", "-é"], true, "", "a\\x{2e}b|\\x{2d}\\x{e9}"],
    [["k_9"], true, "iu", "[Kk\\x{212a}]_9"],
  ] as const) {
    assert.deepEqual(
      await fileCandidateArgs({ patterns: [...patterns], literal, flags, multiline: true }),
      [
        ...COMMON_RG_ARGS,
        "--files-with-matches",
        "--engine=default",
        "--case-sensitive",
        "--encoding=none",
        "-e",
        pattern,
      ],
    );
  }
});

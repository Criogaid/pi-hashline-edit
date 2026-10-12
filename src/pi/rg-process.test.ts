import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRgSucceeded, candidateArgs, COMMON_RG_ARGS, runRgLines } from "./rg-process.ts";
import { fileURLToPath } from "node:url";
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

const listingFixture = fileURLToPath(
  new URL("../testing/rg-line-listing.fixture.mjs", import.meta.url),
);
const parserTimeoutMs = 5_000;

async function parseListing(chunks: readonly string[], maxLines = 10, stop = false) {
  const files: { path: string; lines: readonly number[] | undefined }[] = [];
  const result = await runRgLines(
    process.execPath,
    [
      listingFixture,
      JSON.stringify(chunks.map((chunk) => Buffer.from(chunk).toString("base64"))),
      ...(stop ? ["wait"] : []),
    ],
    AbortSignal.timeout(parserTimeoutMs),
    maxLines,
    (path, lines) => {
      files.push({ path, lines });
      return !stop;
    },
  );
  return { files, result };
}

test("line listing split at every byte → newline paths, empty rows, and grouped files survive", async () => {
  const listing =
    "dir\nfile.txt\0" + "1:\n2:x\n10:[Omitted long matching line]\n\n" + "other.txt\0" + "3:y\n\n";
  const { files, result } = await parseListing([...listing]);
  assert.deepEqual(files, [
    { path: "dir\nfile.txt", lines: [1, 2, 10] },
    { path: "other.txt", lines: [3] },
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stopped, false);
});

test("line listing exceeds maxLines → only the overflowing file requests all-line review", async () => {
  for (const maxLines of [2, 3]) {
    const { files } = await parseListing(
      ["many\0" + "1:x\n2:y\n3:z\n\nfew\0" + "1:\n\n"],
      maxLines,
    );
    assert.deepEqual(files, [
      { path: "many", lines: maxLines === 2 ? undefined : [1, 2, 3] },
      { path: "few", lines: [1] },
    ]);
  }
});

test("line consumer returns false → process stops before the next file", async () => {
  const { files, result } = await parseListing(
    ["first\0" + "1:x\n\nsecond\0" + "2:y\n\n"],
    10,
    true,
  );
  assert.deepEqual(files, [{ path: "first", lines: [1] }]);
  assert.equal(result.stopped, true);
});

test("line listing ends with incomplete path or row → RIPGREP_FAILED", async () => {
  for (const record of ["unfinished-path", "file\0" + "1:x", "file\0" + "1"]) {
    await assert.rejects(
      parseListing([record]),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "RIPGREP_FAILED",
    );
  }
});

test("line listing ends after a complete row → flush the final file without a separator", async () => {
  const { files, result } = await parseListing(["final\0" + "1:x\n"]);
  assert.deepEqual(files, [{ path: "final", lines: [1] }]);
  assert.equal(result.code, 0);
});

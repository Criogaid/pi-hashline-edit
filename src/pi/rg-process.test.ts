import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRgSucceeded,
  candidateArgs,
  COMMON_RG_ARGS,
  runRgLines,
  runCandidatePaths,
  MAX_PREFILTER_PATH_BYTES,
  type runRgPaths,
} from "./rg-process.ts";
import type { Prefilter } from "../core/search-analysis.ts";
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

const conjunction: Prefilter = {
  kind: "and",
  filters: [
    { kind: "literals", literals: [[["a"]]] },
    { kind: "literals", literals: [[["b"]]] },
  ],
};

test("AND file passes → intersect paths before emitting and preserve final callback stop", async () => {
  let pass = 0;
  const calls: string[][] = [];
  const run: typeof runRgPaths = async (_rg, args, _signal, onPath) => {
    calls.push([...args]);
    for (const path of [
      ["a-only", "both"],
      ["b-only", "both", "later"],
    ][pass++])
      if (!(await onPath(path))) return { code: null, stderr: "", stopped: true };
    return { code: 0, stderr: "", stopped: false };
  };
  const paths: string[] = [];
  const result = await runCandidatePaths(
    run,
    "rg",
    conjunction,
    ["--", "root"],
    undefined,
    (path) => {
      paths.push(path);
      return false;
    },
  );
  assert.deepEqual(paths, ["both"]);
  assert.equal(result.stopped, true);
  assert.equal(calls.length, 2);
  for (const args of calls) assert.deepEqual(args.slice(-2), ["--", "root"]);
});

test("AND path retention fills → rerun one necessary clause without excluding its candidates", async () => {
  let pass = 0;
  const run: typeof runRgPaths = async (_rg, _args, _signal, onPath) => {
    const keepGoing = await onPath(
      pass++ === 0 ? "x".repeat(MAX_PREFILTER_PATH_BYTES + 1) : "candidate",
    );
    return { code: keepGoing ? 0 : null, stderr: "", stopped: !keepGoing };
  };
  const paths: string[] = [];
  const result = await runCandidatePaths(
    run,
    "rg",
    conjunction,
    ["--", "root"],
    undefined,
    (path) => {
      paths.push(path);
      return true;
    },
  );
  assert.deepEqual(paths, ["candidate"]);
  assert.equal(pass, 2);
  assert.equal(result.stopped, false);
});

test("incomplete intermediate pass → retain reported candidates and the failure diagnostics", async () => {
  const run: typeof runRgPaths = async (_rg, _args, _signal, onPath) => {
    await onPath("reported");
    return { code: 2, stderr: "unreadable path", stopped: false };
  };
  const paths: string[] = [];
  const result = await runCandidatePaths(run, "rg", conjunction, [], undefined, (path) => {
    paths.push(path);
    return true;
  });
  assert.deepEqual(paths, ["reported"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unreadable path/);
});

test("cancel between AND passes → propagate cancellation before emitting candidates", async () => {
  const controller = new AbortController();
  let pass = 0;
  const run: typeof runRgPaths = async (_rg, _args, signal, onPath) => {
    assert.equal(signal, controller.signal);
    if (pass++) {
      controller.abort(new Error("cancelled"));
      signal?.throwIfAborted();
    }
    await onPath("candidate");
    return { code: 0, stderr: "", stopped: false };
  };
  await assert.rejects(
    runCandidatePaths(run, "rg", conjunction, [], controller.signal, () =>
      assert.fail("cancelled candidate"),
    ),
    /cancelled/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateArgs, runCandidatePaths, MAX_PREFILTER_PATH_BYTES } from "./grep-candidates.ts";
import { COMMON_RG_ARGS, type GrepBackend } from "./rg-process.ts";
import type { Prefilter } from "../core/search-analysis.ts";

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
  const run: GrepBackend["runRgPaths"] = async (_rg, args, _signal, onPath) => {
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
  const run: GrepBackend["runRgPaths"] = async (_rg, _args, _signal, onPath) => {
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
  const run: GrepBackend["runRgPaths"] = async (_rg, _args, _signal, onPath) => {
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
  const run: GrepBackend["runRgPaths"] = async (_rg, _args, signal, onPath) => {
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

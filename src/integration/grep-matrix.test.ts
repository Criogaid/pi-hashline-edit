import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { extractPrefilter } from "../core/search-analysis.ts";
import { searchText, type GrepQuery } from "../core/search.ts";
import {
  acceptsNative,
  matrixCases,
  pairedMatrixCases,
  MATRIX_INPUTS,
} from "../core/search-matrix.testing.ts";
import { assertRgSucceeded, candidateArgs, runRgPaths } from "../pi/rg-process.ts";

interface CandidateCase {
  readonly args: readonly string[];
  readonly required: Map<string, GrepQuery>;
}

async function checkCandidates(t: TestContext, queries: Iterable<{ readonly query: GrepQuery }>) {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-matrix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = MATRIX_INPUTS.map(([label, bytes], index) => ({
    name: `${index}.txt`,
    label,
    bytes,
  }));
  for (const input of inputs) await writeFile(join(directory, input.name), input.bytes);
  const groups = new Map<string, CandidateCase>();
  let accepted = 0;
  let rejected = 0;
  for (const { query } of queries) {
    // This matrix exercises the file prefilter; line candidates have their own differential suite.
    if (!query.multiline) continue;
    if (!acceptsNative(query)) {
      rejected++;
      continue;
    }
    accepted++;
    const args = candidateArgs(extractPrefilter(query));
    const key = JSON.stringify(args);
    let group = groups.get(key);
    if (!group) {
      group = { args, required: new Map() };
      groups.set(key, group);
    }
    for (const input of inputs) {
      // Equal candidate arguments share one rg process; keep a witness for every required file.
      if (group.required.has(input.name)) continue;
      if (searchText({ source: input.bytes.toString("utf8"), query, limit: 1 }).lines.length)
        group.required.set(input.name, query);
    }
  }
  const cases = [...groups.values()];
  let next = 0;
  let checkedFiles = 0;
  let misses = 0;
  const examples: string[] = [];
  const concurrency = 4;
  const processTimeoutMs = 10_000;
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < cases.length) {
        const { args, required } = cases[next++];
        const actual = new Set<string>();
        const result = await runRgPaths(
          rgPath,
          [...args, "--null", "--", directory],
          AbortSignal.timeout(processTimeoutMs),
          (path) => {
            actual.add(basename(path));
            return true;
          },
        );
        assertRgSucceeded(result);
        for (const [name, query] of required) {
          checkedFiles++;
          if (actual.has(name)) continue;
          misses++;
          if (examples.length < 10) {
            const input = inputs.find((input) => input.name === name);
            assert.ok(input);
            examples.push(
              JSON.stringify({
                query,
                args,
                input: input.label,
                bytes: input.bytes.toString("hex"),
              }),
            );
          }
        }
      }
    }),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  t.diagnostic(
    JSON.stringify({
      accepted,
      rejected,
      candidateExpressions: cases.length,
      checkedFiles,
      misses,
    }),
  );
  assert.ok(checkedFiles > 0);
  assert.equal(misses, 0, examples.join("\n"));
}

test("Cartesian multiline JS queries → file prefilter retains all native hits", async (t) => {
  await checkCandidates(t, matrixCases());
});

test("Cartesian paired multiline JS syntax × composition × flags → file prefilter retains native hits", async (t) => {
  await checkCandidates(t, pairedMatrixCases());
});

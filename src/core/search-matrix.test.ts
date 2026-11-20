import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { pictMatrix } from "./pict-matrix.testing.ts";
import { extractPrefilter } from "./search-analysis.ts";
import { searchText } from "./search.ts";
import {
  acceptsNative,
  hasCandidateBytes,
  matrixCases,
  MATRIX_INPUTS,
  type MatrixCase,
} from "./search-matrix.testing.ts";

function checkCandidates(t: TestContext, queries: Iterable<MatrixCase>) {
  let accepted = 0;
  let rejected = 0;
  let evaluations = 0;
  let hits = 0;
  let filteredHits = 0;
  let misses = 0;
  const examples: string[] = [];
  const candidateCache = new Map<string, readonly boolean[]>();
  for (const scenario of queries) {
    if (!acceptsNative(scenario.query)) {
      rejected++;
      continue;
    }
    accepted++;
    const prefilter = extractPrefilter(scenario.query);
    const key = JSON.stringify(prefilter);
    let candidates = candidateCache.get(key);
    if (!candidates) {
      candidates = MATRIX_INPUTS.map(([, bytes]) => hasCandidateBytes(bytes, prefilter));
      candidateCache.set(key, candidates);
    }
    for (const [index, [input, bytes]] of MATRIX_INPUTS.entries()) {
      evaluations++;
      if (
        !searchText({ source: bytes.toString("utf8"), query: scenario.query, limit: 1 }).lines
          .length
      )
        continue;
      hits++;
      if (prefilter.kind !== "all") filteredHits++;
      if (candidates[index]) continue;
      misses++;
      if (examples.length < 10)
        examples.push(
          JSON.stringify({ ...scenario, input, bytes: bytes.toString("hex"), prefilter }),
        );
    }
  }
  t.diagnostic(
    JSON.stringify({
      accepted,
      rejected,
      evaluations,
      hits,
      filteredHits,
      prefilters: candidateCache.size,
      misses,
    }),
  );
  assert.ok(accepted > 0 && filteredHits > 0);
  assert.equal(misses, 0, examples.join("\n"));
}

test("PICT pairwise JS queries → file prefilter retains all native hits", (t) => {
  const { cases, pairCount } = pictMatrix();
  t.diagnostic(`${cases.length} queries cover ${pairCount} pairs of parameter values`);
  checkCandidates(t, cases);
});

test("Cartesian JS syntax × quantifiers × contexts × case modes × line modes × bytes → prefilter never drops a native match", (t) => {
  checkCandidates(t, matrixCases());
});

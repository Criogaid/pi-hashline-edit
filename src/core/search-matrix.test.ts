import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPrefilter } from "./search-analysis.ts";
import { searchText } from "./search.ts";
import {
  acceptsNative,
  hasCandidateBytes,
  matrixCases,
  MATRIX_INPUTS,
} from "./search-matrix.testing.ts";

test("Cartesian JS syntax × quantifiers × contexts × flags × line modes × bytes → prefilter never drops a native match", (t) => {
  let accepted = 0;
  let rejected = 0;
  let evaluations = 0;
  let hits = 0;
  let filteredHits = 0;
  let misses = 0;
  const examples: string[] = [];
  const candidateCache = new Map<string, readonly boolean[]>();
  for (const scenario of matrixCases()) {
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
      if (prefilter.kind === "literals") filteredHits++;
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
  assert.ok(accepted > 0 && rejected > 0 && filteredHits > 0);
  assert.equal(misses, 0, examples.join("\n"));
});

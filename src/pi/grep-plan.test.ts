import assert from "node:assert/strict";
import { test } from "node:test";
import { HashlineError } from "../core/errors.ts";
import { planSearch } from "./grep-plan.ts";
import type { GrepBackend } from "./grep-search.ts";

const backend: GrepBackend = {
  async probeRegex() {
    return { code: 1, stderr: "" };
  },
  async search() {
    throw new Error("Planning must not search files.");
  },
  async runRgPaths() {
    throw new Error("Planning must not enumerate files.");
  },
};

for (const [pattern, multiline, engine] of [
  ["[a-z]+", false, "rg"],
  ["a(?=b)", false, "rg"],
  ["(a+)\\1", true, "rg"],
  ["\\B", false, "rg"],
  ["\\B", true, "javascript"],
  ["(?=a)", true, "javascript"],
  ["^..$", false, "javascript"],
  ["\\uD83D", false, "javascript"],
  ["(a\\n)\\1", true, "javascript"],
  ["^(?:(a)|b)+\\1$", false, "javascript"],
] as const) {
  test(`grep planning: ${pattern} multiline=${multiline} → ${engine}`, async () => {
    const result = await planSearch(
      { patterns: [pattern], multiline, literal: false, flags: "m" },
      "rg",
      backend,
    );
    assert.equal(result.engine, engine);
  });
}

test("grep planning: a compiler rejection selects JS without hiding process failures or cancellation", async () => {
  const query = { patterns: ["(?<=a+)b"], multiline: false, literal: false, flags: "m" };
  const rejected = {
    ...backend,
    async probeRegex() {
      return { code: 2, stderr: "lookbehind is not bounded" };
    },
  };
  assert.equal((await planSearch(query, "rg", rejected)).engine, "javascript");
  await assert.rejects(
    planSearch(query, "rg", {
      ...backend,
      async probeRegex() {
        return { code: 3, stderr: "engine could not start" };
      },
    }),
    (error: unknown) => error instanceof HashlineError && error.errorCode === "RIPGREP_FAILED",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    planSearch(query, "rg", rejected, controller.signal),
    (error: unknown) => error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED",
  );
});

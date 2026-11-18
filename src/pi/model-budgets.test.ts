import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CONTENT_KIB, outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
import { openTestSession } from "../testing/session.testing.ts";
import { registerModelBudgets } from "./model-budgets.ts";

test("session start and model selection → budgets follow the live model", async (t) => {
  let get: ReturnType<typeof registerModelBudgets> | undefined;
  const { session, model } = await openTestSession(t, {
    tools: [],
    configure(pi) {
      get = registerModelBudgets(pi);
      assert.deepEqual(get(), DEFAULT_OUTPUT_BUDGETS);
    },
  });
  assert.ok(get);
  assert.deepEqual(get(), outputBudgetsFor(model.contextWindow));
  const selected = { ...model, id: "small", contextWindow: 65_536 };
  await session.setModel(selected);
  const small = get();
  assert.ok(Object.isFrozen(small));
  assert.deepEqual(small, outputBudgetsFor(selected.contextWindow));
  selected.contextWindow = 1_048_576;
  const large = get();
  assert.deepEqual(large, outputBudgetsFor(selected.contextWindow));
  assert.ok(large.readBytes > small.readBytes);
  assert.ok(large.blockBytes > small.blockBytes);
  assert.ok(large.fieldBytes > small.fieldBytes);
  assert.ok(large.grepPreviewUnits > small.grepPreviewUnits);
  await session.setModel({ ...model, id: "small-again", contextWindow: 65_536 });
  assert.deepEqual(get(), small);
});

test("unknown or invalid model capacity → bounded defaults are used", () => {
  assert.deepEqual(DEFAULT_OUTPUT_BUDGETS, {
    readBytes: 64 * 1024,
    grepBytes: 50 * 1024,
    blockBytes: 16 * 1024,
    fieldBytes: 4 * 1024,
    grepPreviewUnits: 500,
  });
  for (const capacity of [
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
    2.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(outputBudgetsFor(capacity), DEFAULT_OUTPUT_BUDGETS);
  }
});

test("declared model capacity → read and grep shares have independent byte minimums and scaled previews", () => {
  for (const [capacity, readBytes, grepBytes, grepPreviewUnits] of [
    [1, 512, 512, 500],
    [2_047, 512, 512, 500],
    [2_048, 512, 512, 500],
    [2_052, 513, 512, 500],
    [4_095, 1_023, 512, 500],
    [4_096, 1_024, 512, 500],
    [4_104, 1_026, 513, 500],
    [200_000, 50_000, 25_000, 500],
    [384_000, 96_000, 48_000, 500],
    [384_007, 96_001, 48_000, 500],
    [400_000, 100_000, 50_000, 500],
    [400_799, 100_199, 50_099, 500],
    [400_800, 100_200, 50_100, 501],
    [1_000_000, 250_000, 125_000, 1_250],
  ]) {
    const budget = outputBudgetsFor(capacity);
    const scenario = `contextWindow=${capacity}`;
    assert.equal(budget.readBytes, readBytes, scenario);
    assert.equal(budget.grepBytes, grepBytes, scenario);
    assert.equal(budget.grepPreviewUnits, grepPreviewUnits, scenario);
  }
});

test("declared capacity reaches the ceiling → budgets use shares of the capped capacity", () => {
  for (const capacity of [
    MAX_CONTENT_KIB * 1024,
    MAX_CONTENT_KIB * 1024 + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.deepEqual(outputBudgetsFor(capacity), {
      readBytes: 1_048_576,
      grepBytes: 524_288,
      blockBytes: 1_048_576,
      fieldBytes: 262_144,
      grepPreviewUnits: 5_242,
    });
  }
});

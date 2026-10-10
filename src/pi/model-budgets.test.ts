import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OUTPUT_BUDGETS, MAX_CONTENT_KIB, outputBudgetsFor } from "./budgets.ts";
import { createOutputBudgetProvider } from "./model-budgets.ts";

test("unchanged model → budget calculation is lazy and reuses the immutable snapshot", () => {
  let reads = 0;
  let model = { provider: "local", id: "small", contextWindow: 65_536 };
  const get = createOutputBudgetProvider(() => {
    reads++;
    return model;
  });
  assert.equal(reads, 0);
  const first = get();
  assert.ok(Object.isFrozen(first));
  assert.equal(get(), first);
  model = { ...model };
  assert.equal(get(), first);
  model = { ...model, id: "large", contextWindow: 1_048_576 };
  const large = get();
  assert.notEqual(large, first);
  assert.ok(large.readBytes > first.readBytes);
  assert.ok(large.blockBytes > first.blockBytes);
  assert.ok(large.fieldBytes > first.fieldBytes);
  assert.ok(large.grepPreviewUnits > first.grepPreviewUnits);
  assert.equal(get(), large);
  assert.ok(first.readBytes < large.readBytes);
  model = { ...model, contextWindow: 65_536 };
  assert.equal(get().readBytes, first.readBytes);
});

test("unknown or invalid model capacity → bounded defaults are used", () => {
  for (const capacity of [undefined, 0, -1, NaN, Infinity, 2.5]) {
    assert.equal(outputBudgetsFor(capacity), DEFAULT_OUTPUT_BUDGETS);
  }
});

test("declared capacity beyond the explicit ceiling → content budgets cap at read.maxKiB's maximum", () => {
  const capped = outputBudgetsFor(MAX_CONTENT_KIB * 1024 + 1);
  assert.equal(capped.readBytes, MAX_CONTENT_KIB * 1024);
  assert.equal(capped.grepBytes, MAX_CONTENT_KIB * 1024);
  assert.equal(capped.blockBytes, (MAX_CONTENT_KIB * 1024) / 4);
});

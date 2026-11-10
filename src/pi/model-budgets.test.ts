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

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import {
  commandText,
  finalizeMutation,
  generateMutationDetails,
  type MutationFacts,
  type MutationFinalDetails,
  type MutationOutcome,
} from "./mutation-result.ts";
import { displayCarriageReturns } from "./anchor-format.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";

// Checked by tsc; these callers must never run.
function invalidMutationConstruction(
  replacement: MutationOutcome<object, "replace">,
  result: MutationFinalDetails<{ diff: string }>,
) {
  // @ts-expect-error edit has no replacement-count fact.
  const editFacts: MutationFacts<"edit"> = { matches: 1 };
  finalizeMutation(
    "edit",
    "file.txt",
    // @ts-expect-error Replacement facts cannot be finalized as edit facts.
    replacement,
    { freshness: "unchanged" },
    undefined,
    DEFAULT_OUTPUT_BUDGETS,
  );
  // @ts-expect-error A failed mutation has no diff details.
  const diff: string = result.diff;
}

test("command content includes images → report text joins only text blocks", () => {
  assert.equal(
    commandText([
      { type: "text", text: "first" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );
});

for (const [name, before, after] of [
  ["LF", "guard\nold\ntail\n", "guard\nnew\ntail\n"],
  ["CRLF", "guard\r\nold\r\ntail\r\n", "guard\r\nnew\r\ntail\r\n"],
  ["mixed", "guard\r\nold\ntail", "guard\r\nnew\ntail"],
  ["standalone CR", "guard\nold\rtail", "guard\nnew\rtail"],
  ["ending conversion", "same\r\n", "same\n"],
  ["empty file", "", "created"],
  ["BOM and literal escapes", "\uFEFFguard\nold\\n\\0", "\uFEFFguard\nnew\\n\\0"],
  ["no-op", "unchanged\n", "unchanged\n"],
] as const) {
  test(`${name} mutation → details contain only the logical-view diff`, () => {
    const details = generateMutationDetails(before, after);
    const logical = generateDiffString(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    assert.deepEqual(details, {
      diff: displayCarriageReturns(logical.diff),
    });
  });
}

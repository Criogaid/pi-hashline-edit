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
import { byteRevision } from "./file-revision.ts";

// Checked by tsc; these callers must never run.
function invalidMutationConstruction(
  replacement: MutationOutcome<object, "replace">,
  result: MutationFinalDetails<{ diff: string }>,
) {
  // @ts-expect-error edit has no replacement-count fact.
  const editFacts: MutationFacts<"edit"> = { matches: 1 };
  // @ts-expect-error Replacement facts cannot be finalized as edit facts.
  finalizeMutation("edit", "file.txt", replacement, { freshness: "unchanged" });
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
  test(`mutation details preserve byte-faithful diff, logical preview, and revisions for ${name}`, () => {
    const versions = {
      baseRevision: byteRevision(Buffer.from(before)),
      publishedRevision: byteRevision(Buffer.from(after)),
      observedRevision: byteRevision(Buffer.from(after)),
    };
    const details = generateMutationDetails(before, after, versions);
    const raw = generateDiffString(before, after);
    const logical = generateDiffString(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    assert.deepEqual(details, {
      diff: displayCarriageReturns(raw.diff),
      displayDiff: displayCarriageReturns(logical.diff),
      ...versions,
    });
  });
}

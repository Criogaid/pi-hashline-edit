import assert from "node:assert/strict";
import { test } from "node:test";
import { caseVariants } from "./case-fold.ts";
import { MAX_UNIT } from "./character-set.ts";

for (const [char, expected] of [
  ["k", ["K", "k"]],
  ["s", ["S", "s"]],
  ["σ", ["Σ", "ς", "σ"]],
  ["ß", ["ß"]],
  ["😀", ["😀"]],
] as const) {
  test(`${JSON.stringify(char)} → native case variants`, () => {
    assert.deepEqual(caseVariants(char), expected);
    const native = new RegExp(`^${char}$`, "i");
    for (const candidate of ["K", "k", "K", "S", "s", "ſ", "Σ", "σ", "ς", "ß", "é", "😀"])
      assert.equal(
        expected.some((value) => value === candidate),
        native.test(candidate),
        candidate,
      );
  });
}

test("Cartesian non-Unicode code units → case variants agree with native RegExp", () => {
  const allUnits = Array.from({ length: MAX_UNIT + 1 }, (_, unit) =>
    String.fromCharCode(unit),
  ).join("");
  for (let unit = 0; unit <= MAX_UNIT; unit++) {
    const char = String.fromCharCode(unit);
    const source = `\\u${unit.toString(16).padStart(4, "0")}`;
    const expected = allUnits.match(new RegExp(source, "gi"));
    assert.deepEqual(caseVariants(char), expected, source);
  }
});

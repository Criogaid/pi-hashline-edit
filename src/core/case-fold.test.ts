import assert from "node:assert/strict";
import { test } from "node:test";
import { caseVariants } from "./case-fold.ts";
import { MAX_UNIT } from "./character-set.ts";

for (const [char, unicode, expected] of [
  ["k", false, ["K", "k"]],
  ["s", false, ["S", "s"]],
  ["k", true, ["K", "k", "K"]],
  ["s", true, ["S", "s", "ſ"]],
  ["σ", false, ["Σ", "ς", "σ"]],
  ["ß", false, ["ß"]],
  ["😀", false, ["😀"]],
  ["é", true, ["É", "é"]],
  ["K", true, ["K", "k", "K"]],
  ["σ", true, ["Σ", "ς", "σ"]],
  ["𐐀", true, ["𐐀", "𐐨"]],
  ["ß", true, ["ß", "ẞ"]],
] as const) {
  test(`${JSON.stringify(char)} unicode=${unicode} → native case variants`, () => {
    assert.deepEqual(caseVariants(char, unicode), expected);
    for (const flags of unicode ? ["iu", "iv"] : ["i"]) {
      const native = new RegExp(`^${char}$`, flags);
      for (const candidate of ["K", "k", "K", "S", "s", "ſ", "Σ", "σ", "ς", "ß", "é", "😀"])
        assert.equal(
          expected.some((value) => value === candidate),
          native.test(candidate),
          `${flags}: ${candidate}`,
        );
    }
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
    assert.deepEqual(caseVariants(char, false), expected, source);
  }
});

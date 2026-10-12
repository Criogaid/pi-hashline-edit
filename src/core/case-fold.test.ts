import assert from "node:assert/strict";
import { test } from "node:test";
import { caseVariants, equivalentCases } from "./case-fold.ts";

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

test("non-Unicode equivalence groups → every member agrees with native RegExp", () => {
  for (const group of equivalentCases()) {
    const source = `^\\u${group[0].toString(16).padStart(4, "0")}$`;
    const native = new RegExp(source, "i");
    for (const unit of group)
      assert.ok(native.test(String.fromCharCode(unit)), `${source}: ${unit}`);
  }
});

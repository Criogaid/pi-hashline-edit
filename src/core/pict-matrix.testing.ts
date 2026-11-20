import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MATRIX_AXES, matrixCase } from "./search-matrix.testing.ts";

export const PICT_FIXTURE = new URL("./pict-matrix.tsv", import.meta.url);
const axes = Object.entries(MATRIX_AXES);

export function pictModel(): string {
  return axes
    .map(([name, values]) => `${name}: ${values.map((_, index) => index).join(", ")}`)
    .join("\n");
}

export function pictMatrix() {
  const [header, ...lines] = readFileSync(PICT_FIXTURE, "utf8").trimEnd().split(/\r?\n/);
  assert.equal(header, axes.map(([name]) => name).join("\t"));
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    assert.equal(fields.length, axes.length, line);
    return fields.map((value, column) => {
      const index = Number(value);
      assert.match(value, /^\d+$/);
      assert(index < axes[column][1].length, `Invalid PICT row: ${line}`);
      return index;
    });
  });
  let pairCount = 0;
  for (let left = 0; left < axes.length; left++) {
    for (let right = left + 1; right < axes.length; right++) {
      const expected = axes[left][1].length * axes[right][1].length;
      const actual = new Set(rows.map((row) => `${row[left]}:${row[right]}`)).size;
      assert.equal(
        actual,
        expected,
        `Regenerate PICT fixture for ${axes[left][0]} × ${axes[right][0]}`,
      );
      pairCount += actual;
    }
  }
  const { syntax, quantifier, context, ignoreCase, multiline } = MATRIX_AXES;
  const cases = rows.map(([s, q, c, i, m]) =>
    matrixCase(syntax[s], quantifier[q], context[c], ignoreCase[i], multiline[m]),
  );
  return { cases, pairCount };
}

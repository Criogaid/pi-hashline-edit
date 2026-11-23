import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { applyEdits } from "./apply.ts";
import { computeLineHash } from "./hash.ts";
import { splitLines } from "./lines.ts";
import { applyReplacements } from "./replace.ts";
import type { Edit } from "./types.ts";

const PROPERTY_RUNS = 128;
const BOM = "\uFEFF";
const lineEnding = fc.constantFrom("\n", "\r\n");
const fragment = fc
  .array(fc.constantFrom(" ", "a", "é", "😀", BOM, "\r", "\u2028", "\u2029"), { maxLength: 8 })
  .map((characters) => characters.join(""));
const retainedTail = fc
  .tuple(fc.array(fc.tuple(fragment, lineEnding), { maxLength: 6 }), fragment)
  .map(([lines, final]) => lines.map(([line, ending]) => `[${line}]${ending}`).join("") + final);

test("fast-check first-line insertions → preserve the header, body bytes, and untouched suffix", () => {
  fc.assert(
    fc.property(
      lineEnding,
      retainedTail,
      fc.constantFrom("", BOM, BOM.repeat(2)),
      fragment,
      (ending, tail, prefix, text) => {
        const start = `${BOM}first`;
        const source = `${start}${ending}${tail}`;
        const body = prefix + text;
        const anchor = { line: 1, hash: computeLineHash(1, start, 4) };
        const expectedEnding = source.includes("\r\n") || body.endsWith("\r") ? "\r\n" : "\n";
        const expected = `${BOM}${body}${expectedEnding}first${ending}${tail}`;
        const edits = [
          { op: "prepend", body: [body] },
          { op: "insert_before", anchor, body: [body] },
        ] satisfies Edit[];
        for (const edit of edits) {
          const result = applyEdits(source, [edit], 4, 0);
          assert.ok(result.ok);
          assert.equal(result.text, expected, edit.op);
        }
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: 3371 },
  );
});

const copies = fc.constantFrom(
  { prefix: "$<header>", bodyMarks: 0 },
  { prefix: "$<body>", bodyMarks: 1 },
  { prefix: "$<header>$<body>", bodyMarks: 1 },
  { prefix: "$<body>$<header>", bodyMarks: 2 },
  { prefix: "$&$&", bodyMarks: 3 },
  { prefix: BOM + "$<header>", bodyMarks: 2 },
);

test("fast-check header and body captures → preserve their distinct BOM provenance", () => {
  fc.assert(
    fc.property(copies, fragment, retainedTail, ({ prefix, bodyMarks }, text, tail) => {
      const { text: actual, count } = applyReplacements(`${BOM.repeat(2)}keep${tail}`, [
        { literal: false, find: `^(?<header>${BOM})(?<body>${BOM})`, replace: prefix + text },
      ]);
      assert.equal(actual, `${BOM.repeat(1 + bodyMarks)}${text}keep${tail}`);
      assert.equal(count, 1);
    }),
    { numRuns: PROPERTY_RUNS, seed: 4317 },
  );
});

test("fast-check capture templates on LF input → agree with native JavaScript replacement", () => {
  const plain = fc
    .array(fc.constantFrom("a", "é", " ", "😀", "\n"), { maxLength: 8 })
    .map((parts) => parts.join(""));
  const replacement = fc
    .array(
      fc.constantFrom(
        "!",
        "\n",
        "$",
        "$$",
        "$&",
        "$1",
        "$2",
        "$0",
        "$01",
        "$12",
        "$<letter>",
        "$<absent>",
        "$'",
        "$`",
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join(""));
  fc.assert(
    fc.property(plain, plain, plain, replacement, (start, middle, end, template) => {
      const text = `${start}x7${middle}x${end}`;
      const regex = /(?<letter>x)(\d)?/g;
      const { text: actual, count } = applyReplacements(text, [
        { literal: false, find: regex.source, replace: template },
      ]);
      assert.equal(actual, text.replace(regex, template));
      assert.equal(count, 2);
    }),
    { numRuns: PROPERTY_RUNS, seed: 5717 },
  );
});

test("fast-check out-of-order multi-step edits → permutation-invariant text and verified copied spans", () => {
  const bodyLines = fc.array(fragment, { minLength: 1, maxLength: 3 });
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(fc.tuple(fragment, lineEnding), { minLength: 5, maxLength: 7 }),
      fc.boolean(),
      bodyLines,
      bodyLines,
      bodyLines,
      (hasBom, rawLines, trailingNewline, headBody, midBody, tailBody) => {
        const joined = rawLines.map(([line, ending]) => `${line}${ending}`).join("");
        const source =
          (hasBom ? BOM : "") + (trailingNewline ? joined : joined.replace(/\r?\n$/, ""));
        const lines = splitLines(source);
        const at = (line: number) => ({
          line,
          hash: computeLineHash(line, lines[line - 1], 4),
        });
        const canonical: Edit[] = [
          { op: "prepend", body: headBody },
          { op: "replace", anchor: at(2), body: midBody },
          { op: "delete", anchor: at(4) },
          { op: "append", body: tailBody },
        ];
        const reversed = [...canonical].reverse();
        const forward = applyEdits(source, canonical, 4, 0);
        const backward = applyEdits(source, reversed, 4, 0);
        assert.ok(forward.ok && backward.ok);
        assert.equal(backward.text, forward.text);
        assert.deepEqual(backward.copied, forward.copied);
        if (hasBom) assert.ok(forward.text.startsWith(BOM));
        let prevSourceEnd = 0;
        let prevTargetEnd = 0;
        for (const span of forward.copied) {
          assert.ok(span.length > 0);
          assert.ok(span.sourceStart >= prevSourceEnd);
          assert.ok(span.targetStart >= prevTargetEnd);
          prevSourceEnd = span.sourceStart + span.length;
          prevTargetEnd = span.targetStart + span.length;
          assert.ok(prevSourceEnd <= source.length);
          assert.ok(prevTargetEnd <= forward.text.length);
          assert.equal(
            source.slice(span.sourceStart, prevSourceEnd),
            forward.text.slice(span.targetStart, prevTargetEnd),
          );
        }
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: 7919 },
  );
});

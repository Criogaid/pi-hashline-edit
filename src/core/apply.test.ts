import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash } from "./hash.ts";
import { splitLines } from "./lines.ts";
import { applyEdits } from "./apply.ts";
import { HashlineError } from "./errors.ts";
import type { Anchor, Edit } from "./types.ts";

/** Live anchor: hash the current content at the given line (1-based). */
function at(text: string, line: number): Anchor {
  return { line, hash: computeLineHash(line, splitLines(text)[line - 1], 4) };
}

// --- happy paths ---

test("replace single line", () => {
  const text = "a\nb\nc\n";
  const r = applyEdits(text, [{ op: "replace", anchor: at(text, 2), body: ["B"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nB\nc\n");
});

test("editing another line preserves standalone carriage returns at EOF", () => {
  for (const ending of ["\n", "\r\n"]) {
    const text = `first${ending}last\r`;
    const r = applyEdits(text, [{ op: "replace", anchor: at(text, 1), body: ["changed"] }], 4, 15);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.text, `changed${ending}last\r`);
  }
});

test("replace range", () => {
  const text = "a\nb\nc\nd\ne\n";
  const r = applyEdits(
    text,
    [{ op: "replace", anchor: at(text, 2), end: at(text, 4), body: ["X", "Y"] }],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nX\nY\ne\n");
});

test("delete single line / range", () => {
  const text = "a\nb\nc\nd\n";
  const r = applyEdits(text, [{ op: "delete", anchor: at(text, 2), end: at(text, 3) }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nd\n");
});

test("insert_after", () => {
  const text = "a\nb\n";
  const r = applyEdits(text, [{ op: "insert_after", anchor: at(text, 1), body: ["x"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("insert_before", () => {
  const text = "a\nb\n";
  const r = applyEdits(text, [{ op: "insert_before", anchor: at(text, 2), body: ["x"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nx\nb\n");
});

test("append / prepend", () => {
  const text = "a\nb\n";
  const r = applyEdits(
    text,
    [
      { op: "prepend", body: ["head"] },
      { op: "append", body: ["tail"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "head\na\nb\ntail\n");
});

test("multiple out-of-order ops → applied at the right positions", () => {
  const text = "a\nb\nc\n";
  const r = applyEdits(
    text,
    [
      { op: "insert_after", anchor: at(text, 3), body: ["z"] },
      { op: "replace", anchor: at(text, 1), body: ["A"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\nb\nc\nz\n");
});

// --- error paths ---

test("line out of range rejected", () => {
  const text = "a\n";
  const r = applyEdits(
    text,
    [{ op: "replace", anchor: { line: 5, hash: computeLineHash(1, "a", 4) }, body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
});

test("anchor mismatch when the cited line's content differs (live verification)", () => {
  // hash for line 2's content, but cited as line 1 → must fail because line 1's live content differs
  const text = "a\nb\n";
  const r = applyEdits(
    text,
    [{ op: "replace", anchor: { line: 1, hash: computeLineHash(2, "b", 4) }, body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
});

test("overlapping edit spans → report conflicting operations in input order", () => {
  const text = "a\nb\nc\nd\ne\nf\n";
  const range: Edit = { op: "replace", anchor: at(text, 2), end: at(text, 3), body: ["x"] };
  const cases: Edit[][] = [
    [range, { op: "replace", anchor: at(text, 3), body: ["y"] }],
    [range, { op: "delete", anchor: at(text, 2) }],
    [range, { op: "insert_after", anchor: at(text, 2), body: ["y"] }],
    [range, { op: "copy", anchor: at(text, 5), after: at(text, 2) }],
    [
      { op: "move", anchor: at(text, 1), end: at(text, 2), after: at(text, 5) },
      { op: "move", anchor: at(text, 2), end: at(text, 3), before: at(text, 1) },
    ],
  ];
  for (const edits of cases) {
    for (const pair of [edits, [...edits].reverse()]) {
      const batch: Edit[] = [{ op: "append", body: ["tail"] }, ...pair];
      assert.throws(
        () => applyEdits(text, batch, 4, 0),
        (error: unknown) => {
          assert(error instanceof HashlineError);
          assert.equal(error.errorCode, "OVERLAPPING_EDITS");
          assert.equal(error.message, "Two edits overlap.");
          assert.deepEqual(error.facts?.conflict, ["edits[1]", "edits[2]"]);
          return true;
        },
      );
    }
  }
});

test("insertion at a replaced or deleted range start → insert before the range in either batch order", () => {
  const text = "a\nb\nc\nd\n";
  const insertion: Edit = { op: "insert_after", anchor: at(text, 1), body: ["x"] };
  for (const [edit, expected] of [
    [{ op: "replace", anchor: at(text, 2), end: at(text, 3), body: ["B"] }, "a\nx\nB\nd\n"],
    [{ op: "delete", anchor: at(text, 2), end: at(text, 3) }, "a\nx\nd\n"],
  ] satisfies [Edit, string][]) {
    for (const edits of [
      [insertion, edit],
      [edit, insertion],
    ]) {
      const result = applyEdits(text, edits, 4, 0);
      assert(result.ok);
      assert.equal(result.text, expected);
    }
  }
});

test("insertions sharing a gap → reject the batch", () => {
  const text = "a\nb\nc\nd\n";
  const cases: Edit[][] = [
    [
      { op: "insert_after", anchor: at(text, 2), body: ["x"] },
      { op: "insert_before", anchor: at(text, 3), body: ["y"] },
    ],
    [
      { op: "insert_before", anchor: at(text, 3), body: ["x"] },
      { op: "insert_before", anchor: at(text, 3), body: ["y"] },
    ],
    [
      { op: "copy", anchor: at(text, 1), after: at(text, 2) },
      { op: "insert_before", anchor: at(text, 3), body: ["y"] },
    ],
    [
      { op: "move", anchor: at(text, 1), after: at(text, 2) },
      { op: "insert_before", anchor: at(text, 3), body: ["y"] },
    ],
    [
      { op: "append", body: ["x"] },
      { op: "append", body: ["y"] },
    ],
    [
      { op: "prepend", body: ["x"] },
      { op: "insert_before", anchor: at(text, 1), body: ["y"] },
    ],
  ];
  for (const edits of cases) {
    for (const batch of [edits, [...edits].reverse()]) {
      assert.throws(
        () => applyEdits(text, batch, 4, 0),
        (error: unknown) => {
          assert(error instanceof HashlineError);
          assert.equal(error.errorCode, "OVERLAPPING_EDITS");
          assert.equal(error.message, "Two edits insert at one position.");
          assert.deepEqual(error.facts?.conflict, ["edits[0]", "edits[1]"]);
          return true;
        },
      );
    }
  }
});

test("byte-identical edits → validate anchors and preserve the source bytes", () => {
  for (const text of ["a\nb\n", "\uFEFFa\r\nb\n"]) {
    const body = text.startsWith("\uFEFF") ? "\uFEFFa" : "a";
    const r = applyEdits(text, [{ op: "replace", anchor: at(text, 1), body: [body] }], 4, 15);
    assert.ok(r.ok);
    assert.equal(r.text, text);
    const invalid = applyEdits(
      text,
      [{ op: "replace", anchor: at("wrong\nb\n", 1), body: [body] }],
      4,
      15,
    );
    assert.ok(!invalid.ok);
  }
});

test("unrelated change elsewhere does NOT block the edit (no global stale check)", () => {
  // read-time text and current text differ at line 3, but we only touch line 1 — must succeed
  const readText = "a\nb\nc\n";
  const currentText = "a\nb\nCHANGED\n";
  const r = applyEdits(
    currentText,
    [{ op: "replace", anchor: at(readText, 1), body: ["A"] }],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\nb\nCHANGED\n");
});

test("CRLF line endings preserved", () => {
  const text = "a\r\nb\r\n";
  const r = applyEdits(text, [{ op: "replace", anchor: at(text, 1), body: ["A"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\r\nb\r\n");
});

test("editing a mixed-ending file preserves untouched separators", () => {
  const before = "first\r\nsecond\nthird\r\n";
  const result = applyEdits(
    before,
    [{ op: "replace", anchor: at(before, 2), body: ["SECOND"] }],
    4,
    15,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "first\r\nSECOND\nthird\r\n");
});

test("inserting and deleting in mixed-ending files preserves surviving separators", () => {
  const before = "a\r\nb\nc\r\nlast";
  const inserted = applyEdits(
    before,
    [{ op: "insert_after", anchor: at(before, 2), body: ["x"] }],
    4,
    15,
  );
  assert.equal(inserted.ok, true);
  if (inserted.ok) assert.equal(inserted.text, "a\r\nb\nx\r\nc\r\nlast");
  const deleted = applyEdits(before, [{ op: "delete", anchor: at(before, 2) }], 4, 15);
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.text, "a\r\nc\r\nlast");
});

test("replacing one line with several keeps the block's trailing gap", () => {
  const before = "a\r\nb\nc\r\nd";
  const result = applyEdits(
    before,
    [{ op: "replace", anchor: at(before, 2), body: ["X", "Y", "Z"] }],
    4,
    15,
  );
  assert.equal(result.ok, true);
  // b's gap (\n) moves to the last new line, so the boundary to c is unchanged;
  // b has no internal gap; both new internal gaps use the file style, like replace("b", "X\nY\nZ").
  if (result.ok) assert.equal(result.text, "a\r\nX\r\nY\r\nZ\nc\r\nd");
});

test("a file without a final newline keeps not having one", () => {
  const text = "a\nb";
  const r = applyEdits(text, [{ op: "replace", anchor: at(text, 2), body: ["B"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nB");
});

test("CRLF without a final newline keeps not having one", () => {
  const text = "a\r\nb";
  const r = applyEdits(text, [{ op: "replace", anchor: at(text, 1), body: ["A"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\r\nb");
});

test("appending to a file without a final newline keeps it absent", () => {
  const text = "a";
  const r = applyEdits(text, [{ op: "append", body: ["b"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nb");
});

test("edits retain empty final logical lines even without an original final newline", () => {
  for (const text of ["old", "head\nold", "head\r\nold"]) {
    const line = splitLines(text).length;
    const ending = text.includes("\r\n") ? "\r\n" : "\n";
    const prefix = text.slice(0, text.lastIndexOf("\n") + 1);
    const cases: [Edit, string][] = [
      [{ op: "replace", anchor: at(text, line), body: [""] }, prefix + ending],
      [
        { op: "replace", anchor: at(text, line), body: ["new", ""] },
        `${prefix}new${ending}${ending}`,
      ],
      [{ op: "append", body: [""] }, text + ending + ending],
      [{ op: "insert_after", anchor: at(text, line), body: [""] }, text + ending + ending],
    ];
    for (const [edit, expected] of cases) {
      const result = applyEdits(text, [edit], 4, 15);
      assert.ok(result.ok);
      assert.equal(result.text, expected, `${edit.op}: ${JSON.stringify(text)}`);
    }
  }
  // Deleting an unterminated suffix must also retain an existing blank predecessor.
  for (const text of ["\nlast", "head\r\n\r\nlast"]) {
    const result = applyEdits(
      text,
      [{ op: "delete", anchor: at(text, splitLines(text).length) }],
      4,
      15,
    );
    assert.ok(result.ok);
    assert.equal(result.text, text.slice(0, -"last".length));
  }
});

test("a BOM represents an empty first line without a terminator, but not an empty later line", () => {
  const cases: [string, Edit[], string][] = [
    ["\uFEFFold", [{ op: "replace", anchor: at("\uFEFFold", 1), body: [""] }], "\uFEFF"],
    ["\uFEFF", [{ op: "replace", anchor: at("\uFEFF", 1), body: [""] }], "\uFEFF"],
    ["\uFEFF", [{ op: "append", body: [""] }], "\uFEFF\n\n"],
    ["\uFEFF", [{ op: "prepend", body: ["new"] }], "\uFEFFnew\n\n"],
    ["\uFEFF\nlast", [{ op: "delete", anchor: at("\uFEFF\nlast", 2) }], "\uFEFF"],
  ];
  for (const [text, edits, expected] of cases) {
    const result = applyEdits(text, edits, 4, 15);
    assert.ok(result.ok);
    assert.equal(result.text, expected, JSON.stringify({ text, edits }));
  }
});

test("large replacement bodies retain snapshot boundaries without a function argument limit", () => {
  const text = "head\r\nold\ntail";
  const body = Array<string>(150_000).fill("x");
  const result = applyEdits(text, [{ op: "replace", anchor: at(text, 2), body }], 4, 15);
  assert.ok(result.ok);
  assert.equal(result.text, `head\r\n${"x\r\n".repeat(body.length - 1)}x\ntail`);
});

test("noop is still detected when the file lacks a final newline", () => {
  const text = "a\nb";
  const r = applyEdits(text, [{ op: "replace", anchor: at(text, 1), body: ["a"] }], 4, 15);
  assert.ok(r.ok);
  assert.equal(r.text, text);
});

// --- shifted-anchor recovery ---

test("rescued anchor lets the retry succeed without a re-read", () => {
  const readText = "a\nb\nc\nd\ne\n";
  const currentText = "a\nX\nb\nc\nd\ne\n";
  // first attempt with a stale anchor → rescued
  const r1 = applyEdits(
    currentText,
    [{ op: "replace", anchor: at(readText, 3), body: ["C"] }],
    4,
    15,
  );
  assert.ok(!r1.ok);
  const f = r1.failures[0];
  assert.ok(f.recovery.kind === "found");
  assert.equal(f.recovery.newLine, 4);
  assert.equal(computeLineHash(4, splitLines(currentText)[3], 4), f.recovery.newHash);
  // Retry with the recovered anchor; the rest of the file stays unchanged.
  const r2 = applyEdits(
    currentText,
    [
      {
        op: "replace",
        anchor: { line: f.recovery.newLine, hash: f.recovery.newHash },
        body: ["C"],
      },
    ],
    4,
    15,
  );
  assert.ok(r2.ok);
  assert.equal(r2.text, "a\nX\nb\nC\nd\ne\n");
});

test("shifted recovery: duplicate content → ambiguous candidates", () => {
  const readText = "a\nx\nb\nx\nc\n";
  const currentText = "a\nY\nx\nb\nx\nc\n"; // both "x" shifted
  const r = applyEdits(
    currentText,
    [{ op: "replace", anchor: at(readText, 2), body: ["Z"] }],
    4,
    15,
  );
  assert.ok(!r.ok);
  const f = r.failures[0];
  assert.ok(f.recovery.kind === "ambiguous");
  assert.deepEqual(
    f.recovery.candidates.map((c) => c.line),
    [3, 5],
  );
});

test("shifted recovery: content genuinely changed → none", () => {
  const readText = "a\nb\nc\n";
  const currentText = "a\nBCHANGED\nc\n"; // "b" is gone
  const r = applyEdits(
    currentText,
    [{ op: "replace", anchor: at(readText, 2), body: ["B"] }],
    4,
    15,
  );
  assert.ok(!r.ok);
  const f = r.failures[0];
  assert.equal(f.recovery.kind, "none");
});

test("full-file recovery finds distant content and anchors beyond the current EOF", () => {
  for (const [oldLine, newLine] of [
    [2, 90],
    [90, 2],
    [190, 2],
  ]) {
    const lines = Array.from({ length: 100 }, () => "filler");
    lines[newLine - 1] = "target";
    const result = applyEdits(
      lines.join("\n"),
      [{ op: "delete", anchor: { line: oldLine, hash: computeLineHash(oldLine, "target", 4) } }],
      4,
      15,
    );
    assert.ok(!result.ok);
    assert.deepEqual(result.failures[0].recovery, {
      kind: "found",
      newLine,
      newHash: computeLineHash(newLine, "target", 4),
    });
  }
});

test("full-file recovery collects both sides while preserving local candidate priority", () => {
  for (const { positions, selected } of [
    { positions: [3, 95], selected: [3, 95] },
    { positions: [3, 49, 95], selected: [49] },
    { positions: [3, 49, 51, 95], selected: [49, 51] },
  ]) {
    const lines = Array.from({ length: 100 }, () => "filler");
    for (const line of positions) lines[line - 1] = "target";
    const result = applyEdits(
      lines.join("\n"),
      [{ op: "delete", anchor: { line: 50, hash: computeLineHash(50, "target", 4) } }],
      4,
      15,
    );
    assert.ok(!result.ok);
    assert.deepEqual(
      result.failures[0].recovery,
      selected.length === 1
        ? {
            kind: "found",
            newLine: selected[0],
            newHash: computeLineHash(selected[0], "target", 4),
          }
        : {
            kind: "ambiguous",
            candidates: selected.map((line) => ({
              line,
              hash: computeLineHash(line, "target", 4),
            })),
          },
    );
  }
});

test("two stale anchors and overlapping verified edits → return both anchor failures first", () => {
  const readText = "a\nb\nc\nd\n";
  const currentText = "X\na\nb\nc\nd\n"; // inserted X at top → all shifted +1
  const r = applyEdits(
    currentText,
    [
      { op: "replace", anchor: at(readText, 2), body: ["B"] },
      { op: "replace", anchor: at(readText, 4), body: ["D"] },
      { op: "delete", anchor: at(currentText, 1) },
      { op: "replace", anchor: at(currentText, 1), body: ["conflict"] },
    ],
    4,
    15,
  );
  assert.ok(!r.ok);
  assert.equal(r.failures.length, 2);
  const found = r.failures.map((f) => (f.recovery.kind === "found" ? f.recovery.newLine : -1));
  assert.deepEqual(found, [3, 5]);
});

test("shiftRadius=0 disables rescue (always none)", () => {
  const readText = "a\nb\nc\nd\ne\n";
  const currentText = "a\nX\nb\nc\nd\ne\n";
  const r = applyEdits(
    currentText,
    [{ op: "replace", anchor: at(readText, 3), body: ["C"] }],
    4,
    0,
  );
  assert.ok(!r.ok);
  assert.equal(r.failures[0].recovery.kind, "none");
});

test("BOM stays at byte zero through first-line edits while anchors retain their original hashes", () => {
  for (const text of [
    "\uFEFFfirst\nsecond\n",
    "\uFEFFfirst\r\nsecond\r\n",
    "\uFEFFfirst\r\nsecond\n",
    "\uFEFFfirst\nsecond",
  ]) {
    const ending = text.includes("\r\n") ? "\r\n" : "\n";
    const rest = text.slice(text.indexOf("\n") + 1);
    const cases: [Edit, string][] = [
      [{ op: "replace", anchor: at(text, 1), body: ["changed"] }, `\uFEFFchanged${ending}${rest}`],
      [
        { op: "replace", anchor: at(text, 1), body: ["\uFEFFchanged"] },
        `\uFEFFchanged${ending}${rest}`,
      ],
      [{ op: "delete", anchor: at(text, 1) }, `\uFEFF${rest}`],
      [{ op: "prepend", body: ["new"] }, `\uFEFFnew${ending}${text.slice(1)}`],
      [
        { op: "insert_before", anchor: at(text, 1), body: ["new"] },
        `\uFEFFnew${ending}${text.slice(1)}`,
      ],
      [{ op: "delete", anchor: at(text, 1), end: at(text, 2) }, "\uFEFF"],
    ];
    for (const [edit, expected] of cases) {
      const result = applyEdits(text, [edit], 4, 15);
      assert.ok(result.ok);
      assert.equal(result.text, expected, `${edit.op}: ${JSON.stringify(text)}`);
    }
  }
  for (const text of ["\uFEFF", "\uFEFFfirst"]) {
    const result = applyEdits(
      text,
      [{ op: "replace", anchor: at(text, 1), body: ["changed"] }],
      4,
      15,
    );
    assert.ok(result.ok);
    assert.equal(result.text, "\uFEFFchanged");
  }
  const embedded = "\uFEFFfirst\ninside\uFEFFcontent\n";
  const result = applyEdits(
    embedded,
    [{ op: "replace", anchor: at(embedded, 1), body: ["changed"] }],
    4,
    15,
  );
  assert.ok(result.ok);
  assert.equal(result.text, "\uFEFFchanged\ninside\uFEFFcontent\n");
});

test("copy/move original ranges → retain captured text and order", () => {
  const text = "A\nB\nC\nD\n";
  const cases: { edit: Edit; expected: string }[] = [
    {
      edit: { op: "copy", anchor: at(text, 2), end: at(text, 3), after: at(text, 4) },
      expected: "A\nB\nC\nD\nB\nC\n",
    },
    {
      edit: { op: "move", anchor: at(text, 1), end: at(text, 2), after: at(text, 4) },
      expected: "C\nD\nA\nB\n",
    },
    {
      edit: { op: "move", anchor: at(text, 3), end: at(text, 4), before: at(text, 1) },
      expected: "C\nD\nA\nB\n",
    },
    {
      edit: { op: "copy", anchor: at(text, 1), end: at(text, 3), after: at(text, 1) },
      expected: "A\nA\nB\nC\nB\nC\nD\n",
    },
  ];
  for (const { edit, expected } of cases) {
    const result = applyEdits(text, [edit], 4, 0);
    assert(result.ok);
    assert.equal(result.text, expected);
  }
});

test("copy source also replaced or deleted → capture original text regardless of batch order", () => {
  const text = "A\nB\nC\nD\n";
  const copy: Edit = { op: "copy", anchor: at(text, 1), end: at(text, 2), after: at(text, 4) };
  for (const edit of [
    { op: "replace", anchor: at(text, 1), end: at(text, 2), body: ["NEW"] },
    { op: "delete", anchor: at(text, 1), end: at(text, 2) },
  ] satisfies Edit[]) {
    for (const edits of [
      [copy, edit],
      [edit, copy],
    ]) {
      const result = applyEdits(text, edits, 4, 0);
      assert(result.ok);
      assert.equal(result.text, edit.op === "replace" ? "NEW\nC\nD\nA\nB\n" : "C\nD\nA\nB\n");
    }
  }
});

test("copy/move first-line mixed-ending range → preserve source gaps and keep one file BOM", () => {
  const text = "\uFEFFA\r\nB\nC\r\nD\n";
  for (const op of ["copy", "move"] as const) {
    const result = applyEdits(
      text,
      [{ op, anchor: at(text, 1), end: at(text, 3), after: at(text, 4) }],
      4,
      0,
    );
    assert(result.ok);
    assert.equal(result.text, op === "copy" ? text + "A\r\nB\nC\r\n" : "\uFEFFD\nA\r\nB\nC\r\n");
  }
});

test("copy/move unterminated final line → add interior connectors and preserve final-newline state", () => {
  for (const ending of ["\n", "\r\n"]) {
    const text = `A${ending}B`;
    for (const op of ["copy", "move"] as const) {
      const result = applyEdits(text, [{ op, anchor: at(text, 2), before: at(text, 1) }], 4, 0);
      assert(result.ok);
      assert.equal(result.text, op === "copy" ? `B${ending}A${ending}B` : `B${ending}A`);
    }
  }
});

test("copy/move line ending in standalone CR → connector retains the CR as line content", () => {
  const text = "A\nB\r";
  for (const op of ["copy", "move"] as const) {
    const result = applyEdits(text, [{ op, anchor: at(text, 2), before: at(text, 1) }], 4, 0);
    assert(result.ok);
    assert.equal(result.text, op === "copy" ? "B\r\r\nA\nB\r" : "B\r\r\nA");
    assert.equal(splitLines(result.text)[0], "B\r");
  }
});

test("copy Unicode and standalone-CR content → preserve every source code unit", () => {
  const text = "🙂中文 e\u0301\nkeep\rcontent\n";
  const result = applyEdits(
    text,
    [{ op: "copy", anchor: at(text, 1), end: at(text, 2), after: at(text, 2) }],
    4,
    0,
  );
  assert(result.ok);
  assert.equal(result.text, text + text);
});

test("copy blank or BOM-only line → retain the added logical blank line", () => {
  for (const [text, line, expected] of [
    ["A\n\n", 2, "A\n\n\n"],
    ["\uFEFF", 1, "\uFEFF\n\n"],
  ] as const) {
    const result = applyEdits(
      text,
      [{ op: "copy", anchor: at(text, line), after: at(text, line) }],
      4,
      0,
    );
    assert(result.ok);
    assert.equal(result.text, expected);
    assert.equal(splitLines(result.text).length, splitLines(text).length + 1);
  }
});

test("move to either adjacent gap → byte-identical no-op", () => {
  const text = "A\r\nB\nC\r\nD";
  for (const destination of [{ before: at(text, 2) }, { after: at(text, 3) }]) {
    const result = applyEdits(
      text,
      [{ op: "move", anchor: at(text, 2), end: at(text, 3), ...destination }],
      4,
      0,
    );
    assert(result.ok);
    assert.equal(result.text, text);
  }
});

test("copy/move bad source and destination anchors → aggregate every supplied field", () => {
  const text = "A\nB\nC\nD\n";
  for (const op of ["copy", "move"] as const)
    for (const destination of [
      { before: { line: 4, hash: "XXXX" } },
      { after: { line: 4, hash: "XXXX" } },
    ]) {
      const result = applyEdits(
        text,
        [
          {
            op,
            anchor: { line: 1, hash: "XXXX" },
            end: { line: 2, hash: "XXXX" },
            ...destination,
          },
        ],
        4,
        0,
      );
      assert(!result.ok);
      assert.deepEqual(
        result.failures.map((failure) => failure.which),
        ["anchor", "end", Object.keys(destination)[0]],
      );
    }
});

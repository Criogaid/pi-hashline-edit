import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineHash } from "./hash.ts";
import { splitLines } from "./lines.ts";
import { applyEdits } from "./apply.ts";
import type { Anchor, Edit } from "./types.ts";

/** Live anchor: hash the current content at the given line (1-based). */
function at(text: string, line: number): Anchor {
  return { line, hash: computeLineHash(line, splitLines(text)[line - 1], 4) };
}

// --- happy paths ---

test("replace single line", () => {
  const text = "a\nb\nc\n";
  const r = applyEdits(text, [{ op: "replace", start: at(text, 2), body: ["B"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nB\nc\n");
});

test("editing another line preserves standalone carriage returns at EOF", () => {
  for (const ending of ["\n", "\r\n"]) {
    const text = `first${ending}last\r`;
    const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["changed"] }], 4, 15);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.text, `changed${ending}last\r`);
  }
});

test("replace range", () => {
  const text = "a\nb\nc\nd\ne\n";
  const r = applyEdits(
    text,
    [{ op: "replace", start: at(text, 2), end: at(text, 4), body: ["X", "Y"] }],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nX\nY\ne\n");
});

test("delete single line / range", () => {
  const text = "a\nb\nc\nd\n";
  const r = applyEdits(text, [{ op: "delete", start: at(text, 2), end: at(text, 3) }], 4, 15);
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
      { op: "replace", start: at(text, 1), body: ["A"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\nb\nc\nz\n");
});

test("touchedLines covers exactly the lines this edit produced (new-file indices)", () => {
  const text = "a\nb\nc\n";
  const r = applyEdits(
    text,
    [
      { op: "insert_after", anchor: at(text, 3), body: ["z"] },
      { op: "replace", start: at(text, 1), body: ["A"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    // new file: [A, b, c, z]; this edit produced line index 0 (A) and 3 (z)
    assert.deepEqual([...r.touchedLines], [0, 3]);
  }
});

test("touchedLines for append", () => {
  const text = "a\n";
  const r = applyEdits(text, [{ op: "append", body: ["b", "c"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.touchedLines], [1, 2]);
});

test("touchedLines for delete re-anchors the line that shifted into the gap", () => {
  const text = "a\nb\nc\nd\n";
  const r = applyEdits(text, [{ op: "delete", start: at(text, 2) }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) {
    // new file: [a, c, d]; deleting line 2 (b) shifts c into index 1
    assert.deepEqual([...r.touchedLines], [1]);
  }
});

// --- error paths ---

test("anchor hash mismatch rejected (line changed)", () => {
  const text = "a\nb\n";
  const r = applyEdits(
    text,
    [{ op: "replace", start: { line: 1, hash: "WRONG" }, body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("line out of range rejected", () => {
  const text = "a\n";
  const r = applyEdits(
    text,
    [{ op: "replace", start: { line: 5, hash: computeLineHash(1, "a", 4) }, body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("anchor mismatch when the cited line's content differs (live verification)", () => {
  // hash for line 2's content, but cited as line 1 → must fail because line 1's live content differs
  const text = "a\nb\n";
  const r = applyEdits(
    text,
    [{ op: "replace", start: { line: 1, hash: computeLineHash(2, "b", 4) }, body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "anchor");
});

test("reverse-order range rejected", () => {
  const text = "a\nb\nc\n";
  const r = applyEdits(
    text,
    [{ op: "replace", start: at(text, 3), end: at(text, 1), body: ["x"] }],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("overlapping edits rejected", () => {
  const text = "a\nb\nc\nd\n";
  const r = applyEdits(
    text,
    [
      { op: "replace", start: at(text, 2), end: at(text, 3), body: ["x"] },
      { op: "replace", start: at(text, 3), body: ["y"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("conflict at the same insertion point rejected", () => {
  const text = "a\nb\n";
  const r = applyEdits(
    text,
    [
      { op: "insert_after", anchor: at(text, 1), body: ["x"] },
      { op: "insert_after", anchor: at(text, 1), body: ["y"] },
    ],
    4,
    15,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure.kind, "range");
});

test("byte-identical edits succeed without updated anchors after validation", () => {
  for (const text of ["a\nb\n", "\uFEFFa\r\nb\n"]) {
    const body = text.startsWith("\uFEFF") ? "\uFEFFa" : "a";
    const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: [body] }], 4, 15);
    assert.deepEqual(r, { ok: true, text, changed: false, touchedLines: [], contextLines: [] });
    const invalid = applyEdits(
      text,
      [{ op: "replace", start: at("wrong\nb\n", 1), body: [body] }],
      4,
      15,
    );
    assert.ok(!invalid.ok && invalid.failure.kind === "anchor");
  }
});

test("unrelated change elsewhere does NOT block the edit (no global stale check)", () => {
  // read-time text and current text differ at line 3, but we only touch line 1 — must succeed
  const readText = "a\nb\nc\n";
  const currentText = "a\nb\nCHANGED\n";
  const r = applyEdits(
    currentText,
    [{ op: "replace", start: at(readText, 1), body: ["A"] }],
    4,
    15,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\nb\nCHANGED\n");
});

test("CRLF line endings preserved", () => {
  const text = "a\r\nb\r\n";
  const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["A"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "A\r\nb\r\n");
});

test("editing a mixed-ending file preserves untouched separators", () => {
  const before = "first\r\nsecond\nthird\r\n";
  const result = applyEdits(
    before,
    [{ op: "replace", start: at(before, 2), body: ["SECOND"] }],
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
  const deleted = applyEdits(before, [{ op: "delete", start: at(before, 2) }], 4, 15);
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.text, "a\r\nc\r\nlast");
});

test("replacing one line with several keeps the block's trailing gap", () => {
  const before = "a\r\nb\nc\r\nd";
  const result = applyEdits(
    before,
    [{ op: "replace", start: at(before, 2), body: ["X", "Y", "Z"] }],
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
  const r = applyEdits(text, [{ op: "replace", start: at(text, 2), body: ["B"] }], 4, 15);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "a\nB");
});

test("CRLF without a final newline keeps not having one", () => {
  const text = "a\r\nb";
  const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["A"] }], 4, 15);
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
    const cases: [Edit, string, number[]][] = [
      [{ op: "replace", start: at(text, line), body: [""] }, prefix + ending, [line - 1]],
      [
        { op: "replace", start: at(text, line), body: ["new", ""] },
        `${prefix}new${ending}${ending}`,
        [line - 1, line],
      ],
      [{ op: "append", body: [""] }, text + ending + ending, [line]],
      [{ op: "insert_after", anchor: at(text, line), body: [""] }, text + ending + ending, [line]],
    ];
    for (const [edit, expected, touched] of cases) {
      const result = applyEdits(text, [edit], 4, 15);
      assert.ok(result.ok);
      assert.equal(result.text, expected, `${edit.op}: ${JSON.stringify(text)}`);
      assert.deepEqual(result.touchedLines, touched);
      const newLines = splitLines(result.text);
      assert.ok(result.touchedLines.every((index) => index < newLines.length));
    }
  }
  // Deleting an unterminated suffix must also retain an existing blank predecessor.
  for (const text of ["\nlast", "head\r\n\r\nlast"]) {
    const result = applyEdits(
      text,
      [{ op: "delete", start: at(text, splitLines(text).length) }],
      4,
      15,
    );
    assert.ok(result.ok);
    assert.equal(result.text, text.slice(0, -"last".length));
    assert.deepEqual(result.touchedLines, []);
  }
});

test("a BOM represents an empty first line without a terminator, but not an empty later line", () => {
  const cases: [string, Edit[], string, number[]][] = [
    ["\uFEFFold", [{ op: "replace", start: at("\uFEFFold", 1), body: [""] }], "\uFEFF", [0]],
    ["\uFEFF", [{ op: "replace", start: at("\uFEFF", 1), body: [""] }], "\uFEFF", []],
    ["\uFEFF", [{ op: "append", body: [""] }], "\uFEFF\n\n", [1]],
    ["\uFEFF", [{ op: "prepend", body: ["new"] }], "\uFEFFnew\n\n", [0]],
    ["\uFEFF\nlast", [{ op: "delete", start: at("\uFEFF\nlast", 2) }], "\uFEFF", []],
  ];
  for (const [text, edits, expected, touched] of cases) {
    const result = applyEdits(text, edits, 4, 15);
    assert.ok(result.ok);
    assert.equal(result.text, expected, JSON.stringify({ text, edits }));
    assert.deepEqual(result.touchedLines, touched);
  }
});

test("large replacement bodies retain snapshot boundaries without a function argument limit", () => {
  const text = "head\r\nold\ntail";
  const body = Array<string>(150_000).fill("x");
  const result = applyEdits(text, [{ op: "replace", start: at(text, 2), body }], 4, 15);
  assert.ok(result.ok);
  assert.equal(result.text, `head\r\n${"x\r\n".repeat(body.length - 1)}x\ntail`);
  assert.equal(result.touchedLines.length, body.length);
  assert.equal(result.touchedLines[0], 1);
  assert.equal(result.touchedLines.at(-1), body.length);
  assert.deepEqual(result.contextLines, []);
});

test("noop is still detected when the file lacks a final newline", () => {
  const text = "a\nb";
  const r = applyEdits(text, [{ op: "replace", start: at(text, 1), body: ["a"] }], 4, 15);
  assert.deepEqual(r, { ok: true, text, changed: false, touchedLines: [], contextLines: [] });
});

// --- shifted-anchor recovery ---

test("shifted recovery: content moved down → found with a fresh anchor", () => {
  const readText = "a\nb\nc\nd\ne\n";
  const currentText = "a\nX\nb\nc\nd\ne\n"; // inserted X after line 1 → "c" moved 3→4
  const r = applyEdits(
    currentText,
    [{ op: "replace", start: at(readText, 3), body: ["C"] }],
    4,
    15,
  );
  assert.ok(!r.ok && r.failure.kind === "anchor");
  const f = r.failure.failures[0];
  assert.ok(f.recovery.kind === "found");
  assert.equal(f.recovery.newLine, 4);
  assert.equal(f.recovery.scope, "local");
  // The recovered anchor must verify against the current file.
  assert.equal(computeLineHash(4, splitLines(currentText)[3], 4), f.recovery.newHash);
});

test("rescued anchor lets the retry succeed without a re-read", () => {
  const readText = "a\nb\nc\nd\ne\n";
  const currentText = "a\nX\nb\nc\nd\ne\n";
  // first attempt with a stale anchor → rescued
  const r1 = applyEdits(
    currentText,
    [{ op: "replace", start: at(readText, 3), body: ["C"] }],
    4,
    15,
  );
  assert.ok(!r1.ok && r1.failure.kind === "anchor");
  const f = r1.failure.failures[0];
  assert.ok(f.recovery.kind === "found");
  // Retry with the recovered anchor; the rest of the file stays unchanged.
  const r2 = applyEdits(
    currentText,
    [{ op: "replace", start: { line: f.recovery.newLine, hash: f.recovery.newHash }, body: ["C"] }],
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
    [{ op: "replace", start: at(readText, 2), body: ["Z"] }],
    4,
    15,
  );
  assert.ok(!r.ok && r.failure.kind === "anchor");
  const f = r.failure.failures[0];
  assert.ok(f.recovery.kind === "ambiguous");
  assert.equal(f.recovery.scope, "local");
  assert.deepEqual(
    f.recovery.candidates.map((c) => c.line),
    [3, 5],
  );
});

test("shifted recovery: content genuinely changed → none, with live content", () => {
  const readText = "a\nb\nc\n";
  const currentText = "a\nBCHANGED\nc\n"; // "b" is gone
  const r = applyEdits(
    currentText,
    [{ op: "replace", start: at(readText, 2), body: ["B"] }],
    4,
    15,
  );
  assert.ok(!r.ok && r.failure.kind === "anchor");
  const f = r.failure.failures[0];
  assert.equal(f.recovery.kind, "none");
  assert.equal(f.current?.content, "BCHANGED");
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
      [{ op: "delete", start: { line: oldLine, hash: computeLineHash(oldLine, "target", 4) } }],
      4,
      15,
    );
    assert.ok(!result.ok && result.failure.kind === "anchor");
    assert.deepEqual(result.failure.failures[0].recovery, {
      kind: "found",
      scope: "full-file",
      newLine,
      newHash: computeLineHash(newLine, "target", 4),
    });
  }
});

test("full-file recovery collects both sides while preserving local candidate priority", () => {
  for (const { positions, selected, scope } of [
    { positions: [3, 95], selected: [3, 95], scope: "full-file" },
    { positions: [3, 49, 95], selected: [49], scope: "local" },
    { positions: [3, 49, 51, 95], selected: [49, 51], scope: "local" },
  ]) {
    const lines = Array.from({ length: 100 }, () => "filler");
    for (const line of positions) lines[line - 1] = "target";
    const result = applyEdits(
      lines.join("\n"),
      [{ op: "delete", start: { line: 50, hash: computeLineHash(50, "target", 4) } }],
      4,
      15,
    );
    assert.ok(!result.ok && result.failure.kind === "anchor");
    assert.deepEqual(
      result.failure.failures[0].recovery,
      selected.length === 1
        ? {
            kind: "found",
            scope,
            newLine: selected[0],
            newHash: computeLineHash(selected[0], "target", 4),
          }
        : {
            kind: "ambiguous",
            scope,
            candidates: selected.map((line) => ({
              line,
              hash: computeLineHash(line, "target", 4),
            })),
          },
    );
  }
});

test("collect-all: two stale anchors in one batch → both failures returned", () => {
  const readText = "a\nb\nc\nd\n";
  const currentText = "X\na\nb\nc\nd\n"; // inserted X at top → all shifted +1
  const r = applyEdits(
    currentText,
    [
      { op: "replace", start: at(readText, 2), body: ["B"] },
      { op: "replace", start: at(readText, 4), body: ["D"] },
    ],
    4,
    15,
  );
  assert.ok(!r.ok && r.failure.kind === "anchor");
  assert.equal(r.failure.failures.length, 2);
  const found = r.failure.failures.map((f) =>
    f.recovery.kind === "found" ? f.recovery.newLine : -1,
  );
  assert.deepEqual(found, [3, 5]);
});

test("shiftRadius=0 disables rescue (always none)", () => {
  const readText = "a\nb\nc\nd\ne\n";
  const currentText = "a\nX\nb\nc\nd\ne\n";
  const r = applyEdits(currentText, [{ op: "replace", start: at(readText, 3), body: ["C"] }], 4, 0);
  assert.ok(!r.ok && r.failure.kind === "anchor");
  assert.equal(r.failure.failures[0].recovery.kind, "none");
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
      [{ op: "replace", start: at(text, 1), body: ["changed"] }, `\uFEFFchanged${ending}${rest}`],
      [
        { op: "replace", start: at(text, 1), body: ["\uFEFFchanged"] },
        `\uFEFFchanged${ending}${rest}`,
      ],
      [{ op: "delete", start: at(text, 1) }, `\uFEFF${rest}`],
      [{ op: "prepend", body: ["new"] }, `\uFEFFnew${ending}${text.slice(1)}`],
      [
        { op: "insert_before", anchor: at(text, 1), body: ["new"] },
        `\uFEFFnew${ending}${text.slice(1)}`,
      ],
      [{ op: "delete", start: at(text, 1), end: at(text, 2) }, "\uFEFF"],
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
      [{ op: "replace", start: at(text, 1), body: ["changed"] }],
      4,
      15,
    );
    assert.ok(result.ok);
    assert.equal(result.text, "\uFEFFchanged");
  }
  const embedded = "\uFEFFfirst\ninside\uFEFFcontent\n";
  const result = applyEdits(
    embedded,
    [{ op: "replace", start: at(embedded, 1), body: ["changed"] }],
    4,
    15,
  );
  assert.ok(result.ok);
  assert.equal(result.text, "\uFEFFchanged\ninside\uFEFFcontent\n");
});

test("failed batches report every supplied anchor in input order from one snapshot", () => {
  const text = "a\nb\nc\nd\ne\nf\n";
  const stale = { line: 2, hash: "ZZ" };
  const edits: Edit[] = [
    { op: "replace", start: at(text, 1), end: stale, body: ["A"] },
    { op: "delete", start: stale, end: at(text, 4) },
    { op: "insert_after", anchor: at(text, 5), body: ["E"] },
    { op: "insert_before", anchor: stale, body: ["B"] },
    { op: "append", body: ["last"] },
    { op: "prepend", body: ["first"] },
  ];
  const result = applyEdits(text, edits, 4, 15);
  assert.ok(!result.ok && result.failure.kind === "anchor");
  assert.deepEqual(result.failure.checks, [
    { opIndex: 0, op: "replace", which: "anchor", cited: at(text, 1), status: "matched" },
    { opIndex: 0, op: "replace", which: "end", cited: stale, status: "mismatched" },
    { opIndex: 1, op: "delete", which: "anchor", cited: stale, status: "mismatched" },
    { opIndex: 1, op: "delete", which: "end", cited: at(text, 4), status: "matched" },
    { opIndex: 2, op: "insert_after", which: "anchor", cited: at(text, 5), status: "matched" },
    { opIndex: 3, op: "insert_before", which: "anchor", cited: stale, status: "mismatched" },
  ]);
});

test("matched anchor checks do not imply valid ranges", () => {
  const text = "a\nb\nc\n";
  const cases: { edits: Edit[]; kind: "range"; checks: number }[] = [
    { edits: [{ op: "delete", start: at(text, 3), end: at(text, 1) }], kind: "range", checks: 2 },
    {
      edits: [
        { op: "replace", start: at(text, 1), end: at(text, 3), body: ["x"] },
        { op: "delete", start: at(text, 2) },
      ],
      kind: "range",
      checks: 3,
    },
  ];
  for (const { edits, kind, checks } of cases) {
    const result = applyEdits(text, edits, 4, 15);
    assert.ok(!result.ok);
    assert.equal(result.failure.kind, kind);
    assert.equal(result.failure.checks.length, checks);
    assert.ok(result.failure.checks.every((check) => check.status === "matched"));
  }
});

test("copy/move original ranges → retain order and report final produced positions", () => {
  const text = "A\nB\nC\nD\n";
  const cases: { edit: Edit; expected: string; touched: number[]; context: number[] }[] = [
    {
      edit: { op: "copy", start: at(text, 2), end: at(text, 3), after: at(text, 4) },
      expected: "A\nB\nC\nD\nB\nC\n",
      touched: [4, 5],
      context: [],
    },
    {
      edit: { op: "move", start: at(text, 1), end: at(text, 2), after: at(text, 4) },
      expected: "C\nD\nA\nB\n",
      touched: [0, 2, 3],
      context: [0],
    },
    {
      edit: { op: "move", start: at(text, 3), end: at(text, 4), before: at(text, 1) },
      expected: "C\nD\nA\nB\n",
      touched: [0, 1],
      context: [],
    },
    {
      edit: { op: "copy", start: at(text, 1), end: at(text, 3), after: at(text, 1) },
      expected: "A\nA\nB\nC\nB\nC\nD\n",
      touched: [1, 2, 3],
      context: [],
    },
  ];
  for (const { edit, expected, touched, context } of cases) {
    const result = applyEdits(text, [edit], 4, 0);
    assert(result.ok);
    assert.equal(result.text, expected);
    assert.deepEqual(result.touchedLines, touched);
    assert.deepEqual(result.contextLines, context);
  }
});

test("copy source also replaced or deleted → capture original text regardless of batch order", () => {
  const text = "A\nB\nC\nD\n";
  const copy: Edit = { op: "copy", start: at(text, 1), end: at(text, 2), after: at(text, 4) };
  for (const edit of [
    { op: "replace", start: at(text, 1), end: at(text, 2), body: ["NEW"] },
    { op: "delete", start: at(text, 1), end: at(text, 2) },
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
      [{ op, start: at(text, 1), end: at(text, 3), after: at(text, 4) }],
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
      const result = applyEdits(text, [{ op, start: at(text, 2), before: at(text, 1) }], 4, 0);
      assert(result.ok);
      assert.equal(result.text, op === "copy" ? `B${ending}A${ending}B` : `B${ending}A`);
    }
  }
});

test("copy/move line ending in standalone CR → connector retains the CR as line content", () => {
  const text = "A\nB\r";
  for (const op of ["copy", "move"] as const) {
    const result = applyEdits(text, [{ op, start: at(text, 2), before: at(text, 1) }], 4, 0);
    assert(result.ok);
    assert.equal(result.text, op === "copy" ? "B\r\r\nA\nB\r" : "B\r\r\nA");
    assert.equal(splitLines(result.text)[0], "B\r");
  }
});

test("copy Unicode and standalone-CR content → preserve every source code unit", () => {
  const text = "🙂中文 e\u0301\nkeep\rcontent\n";
  const result = applyEdits(
    text,
    [{ op: "copy", start: at(text, 1), end: at(text, 2), after: at(text, 2) }],
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
      [{ op: "copy", start: at(text, line), after: at(text, line) }],
      4,
      0,
    );
    assert(result.ok);
    assert.equal(result.text, expected);
    assert.equal(splitLines(result.text).length, splitLines(text).length + 1);
  }
});

test("move to either adjacent gap → byte-identical no-op with no updated anchors", () => {
  const text = "A\r\nB\nC\r\nD";
  for (const destination of [{ before: at(text, 2) }, { after: at(text, 3) }]) {
    const result = applyEdits(
      text,
      [{ op: "move", start: at(text, 2), end: at(text, 3), ...destination }],
      4,
      0,
    );
    assert(result.ok);
    assert.equal(result.text, text);
    assert.equal(result.changed, false);
    assert.deepEqual(result.touchedLines, []);
  }
});

test("copy/move bad source and destination anchors → aggregate every supplied field", () => {
  const text = "A\nB\nC\nD\n";
  for (const destination of [
    { before: { line: 4, hash: "XXXX" } },
    { after: { line: 4, hash: "XXXX" } },
  ]) {
    const result = applyEdits(
      text,
      [
        {
          op: "copy",
          start: { line: 1, hash: "XXXX" },
          end: { line: 2, hash: "XXXX" },
          ...destination,
        },
      ],
      4,
      0,
    );
    assert(!result.ok && result.failure.kind === "anchor");
    assert.deepEqual(
      result.failure.failures.map((failure) => failure.which),
      ["anchor", "end", Object.keys(destination)[0]],
    );
    assert(result.failure.checks.every((check) => check.status === "mismatched"));
  }
});

test("move interior destination, overlapping moves, or duplicate copy gaps → reject the complete batch", () => {
  const text = "A\nB\nC\nD\nE\n";
  const cases: Edit[][] = [
    [{ op: "move", start: at(text, 1), end: at(text, 3), after: at(text, 2) }],
    [
      { op: "move", start: at(text, 1), end: at(text, 2), after: at(text, 5) },
      { op: "move", start: at(text, 2), end: at(text, 3), before: at(text, 1) },
    ],
    [
      { op: "copy", start: at(text, 1), after: at(text, 5) },
      { op: "copy", start: at(text, 2), after: at(text, 5) },
    ],
    [{ op: "copy", start: at(text, 3), end: at(text, 2), after: at(text, 5) }],
  ];
  for (const edits of cases) {
    const result = applyEdits(text, edits, 4, 0);
    assert(!result.ok && result.failure.kind === "range");
    assert(result.failure.checks.every((check) => check.status === "matched"));
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { CopiedSpan } from "../core/copy-span.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { generateRangeDiff } from "./mutation-diff.ts";

function partitions(diff: string) {
  const before: [number, string][] = [];
  const after: [number, string][] = [];
  const context: [number, string][] = [];
  for (const line of diff ? diff.split("\n") : []) {
    if (/^ +\.\.\.$/.test(line)) continue;
    const match = /^([ +\-]) *(\d+) ([\s\S]*)$/.exec(line);
    assert.ok(match, `Invalid Pi diff row: ${JSON.stringify(line)}`);
    const rows = match[1] === "-" ? before : match[1] === "+" ? after : context;
    rows.push([Number(match[2]), match[3]]);
  }
  return { before, after, context };
}

test("range diff with duplicate rows → removes the occurrence outside the copied span", () => {
  const line = "same\n";
  const before = line.repeat(3);
  const after = line.repeat(2);
  const actual = generateRangeDiff(before, after, [
    { sourceStart: line.length, targetStart: 0, length: after.length },
  ]);
  assert.deepEqual(partitions(actual), {
    before: [[1, "same"]],
    after: [],
    context: [
      [2, "same"],
      [3, "same"],
    ],
  });
});

test("range diff across separated edits → retains Pi's global numbering and context style", () => {
  const lines = (start: number, end: number) =>
    Array.from({ length: end - start }, (_, i) => `row ${start + i}\n`).join("");
  const head = lines(1, 7);
  const middle = lines(8, 24);
  const tail = lines(25, 33);
  const oldFirst = `${head}old first\n`;
  const newFirst = `${head}new first\nextra line\n`;
  const oldSecond = `${oldFirst}${middle}old second\n`;
  const newSecond = `${newFirst}${middle}`;
  const before = oldSecond + tail;
  const after = newSecond + tail;
  const copied: CopiedSpan[] = [
    { sourceStart: 0, targetStart: 0, length: head.length },
    { sourceStart: oldFirst.length, targetStart: newFirst.length, length: middle.length },
    { sourceStart: oldSecond.length, targetStart: newSecond.length, length: tail.length },
  ];
  assert.equal(generateRangeDiff(before, after, copied), generateDiffString(before, after).diff);
});

for (const [name, oldHead, newHead, shared, oldTail, newTail] of [
  ["partial starts and mixed endings", "old\n", "new\r", "edge\r\nint\rerior\nlast\r", "\n", "!"],
  ["copied LF and a newly terminated EOF row", "left\r", "left", "\nkeep\nlast", "", "\n"],
  ["standalone CR at EOF", "", "", "guard\r\nlast\r", "", "\r\n"],
  ["only CRLF normalization", "left\r", "left", "\nsame\r\n", "", ""],
] as const) {
  test(`range diff with ${name} → renders the same row partitions as the whole logical diff`, () => {
    const before = oldHead + shared + oldTail;
    const after = newHead + shared + newTail;
    const copied = [
      { sourceStart: oldHead.length, targetStart: newHead.length, length: shared.length },
    ];
    const native = generateDiffString(
      normalizeLineEndings(before),
      normalizeLineEndings(after),
    ).diff;
    assert.deepEqual(partitions(generateRangeDiff(before, after, copied)), partitions(native));
  });
}

test("range diff with sparse changes inside one large replacement → retains interior rows across a shift", () => {
  const old = Array.from({ length: 96 }, (_, i) => `const option${i + 1} = true;\n`);
  old[44] = 'const region = "us-east-1";\n';
  const next = [...old];
  next[9] = "const retryLimit = 4;\n";
  next[85] = "const timeoutMs = 6000;\n";
  next.splice(10, 0, "const backoffMs = 200;\n");
  const head = old.slice(0, 9).join("");
  const tail = old.slice(86).join("");
  const before = old.join("");
  const after = next.join("");
  const spans: CopiedSpan[] = [
    { sourceStart: 0, targetStart: 0, length: head.length },
    {
      sourceStart: before.length - tail.length,
      targetStart: after.length - tail.length,
      length: tail.length,
    },
  ];
  assert.deepEqual(
    partitions(generateRangeDiff(before, after, spans)),
    partitions(generateDiffString(before, after).diff),
  );
});

test("range diff with a dense gap → shows actual removed and added rows", () => {
  const count = 1_000;
  const removed = Array.from({ length: count }, (_, i) => `old ${i}`);
  const added = Array.from({ length: count }, (_, i) => `new ${i}`);
  const head = "head\r\n";
  const tail = "\ntail";
  const before = head + removed.join("\n") + tail;
  const after = head + added.join("\n") + tail;
  const copied = [
    { sourceStart: 0, targetStart: 0, length: head.length },
    {
      sourceStart: before.length - tail.length,
      targetStart: after.length - tail.length,
      length: tail.length,
    },
  ];
  assert.deepEqual(partitions(generateRangeDiff(before, after, copied)), {
    before: removed.map((line, i) => [i + 2, line]),
    after: added.map((line, i) => [i + 2, line]),
    context: [
      [1, "head"],
      [count + 2, "tail"],
    ],
  });
});

for (const [name, before, after, copied, expected] of [
  [
    "copied EOF body and CRLF with a standalone CR",
    "same\r\r\nsame\r",
    "same\r",
    [{ sourceStart: 0, targetStart: 0, length: "same\r".length }],
    { before: [[2, "same\r"]], after: [], context: [[1, "same\r"]] },
  ],
  [
    "partial body without row identity",
    "same\nsame",
    "same",
    [{ sourceStart: 1, targetStart: 1, length: "ame".length }],
    { before: [[1, "same"]], after: [], context: [[2, "same"]] },
  ],
  [
    "only the final LF removed",
    "same\n",
    "same",
    [{ sourceStart: 0, targetStart: 0, length: "same".length }],
    { before: [[1, "same"]], after: [[1, "same"]], context: [] },
  ],
] as const) {
  test(`range diff with ${name} → aligns only eligible EOF bodies by identity`, () => {
    assert.deepEqual(partitions(generateRangeDiff(before, after, copied)), expected);
  });
}

test("equal row counts with a copied EOF body → mark the changed occurrence in either direction", () => {
  const before = "same\nsame";
  const after = "same\nother";
  assert.deepEqual(
    partitions(generateRangeDiff(before, after, [{ sourceStart: 5, targetStart: 0, length: 4 }])),
    { before: [[1, "same"]], after: [[2, "other"]], context: [[2, "same"]] },
  );
  assert.deepEqual(
    partitions(generateRangeDiff(after, before, [{ sourceStart: 0, targetStart: 5, length: 4 }])),
    { before: [[2, "other"]], after: [[1, "same"]], context: [[1, "same"]] },
  );
});

test("EOF body identity beyond the alignment budget → fallback keeps the proven row", () => {
  const repeated = Array<string>(1_001).fill("same");
  const before = repeated.join("\n");
  const after = "same";
  const retained = 501;
  const copied = [
    { sourceStart: (retained - 1) * "same\n".length, targetStart: 0, length: after.length },
  ];
  const actual = partitions(generateRangeDiff(before, after, copied));
  const removed = repeated.flatMap((line, i) => (i + 1 === retained ? [] : [[i + 1, line]]));
  assert.deepEqual(actual, { before: removed, after: [], context: [[retained, "same"]] });
  const reverse = copied.map(({ sourceStart, targetStart, length }) => ({
    sourceStart: targetStart,
    targetStart: sourceStart,
    length,
  }));
  assert.deepEqual(partitions(generateRangeDiff(after, before, reverse)), {
    before: [],
    after: removed,
    context: [[1, "same"]],
  });
});

test("shorter textual alignment skips the copied EOF body → fallback preserves the copy", () => {
  const before = "same\nx\ny\nsame";
  const after = "x\ny\nsame";
  const copied = [{ sourceStart: 0, targetStart: "x\ny\n".length, length: "same".length }];
  assert.deepEqual(partitions(generateRangeDiff(before, after, copied)), {
    before: [
      [2, "x"],
      [3, "y"],
      [4, "same"],
    ],
    after: [
      [1, "x"],
      [2, "y"],
    ],
    context: [[1, "same"]],
  });
});

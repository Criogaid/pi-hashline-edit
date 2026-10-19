import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import { applyEdits } from "../core/apply.ts";
import type { AnchorFailure, Edit } from "../core/types.ts";
import { formatKiB, DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { ambiguousCandidateNeighborhoods, describeEditFailure } from "./failure-context.ts";
import { describeFailure, renderReport } from "./report.ts";

function failure(recovery: AnchorFailure["recovery"]): AnchorFailure {
  return {
    opIndex: 0,
    which: "anchor",
    op: "replace",
    cited: { line: 1, hash: "OLD" },
    recovery,
    current: null,
  };
}
function ambiguous(lines: readonly string[], positions: number[], hashLen = 4): AnchorFailure {
  return failure({
    kind: "ambiguous",
    scope: "local",
    candidates: positions.map((line) => ({
      line,
      hash: computeLineHash(line, lines[line - 1], hashLen),
    })),
  });
}
function neighborhoods(text: string, failures: readonly AnchorFailure[], hashLen = 4) {
  return ambiguousCandidateNeighborhoods(text, failures, createAnchorFormatter(hashLen));
}
function rows(result: ReturnType<typeof neighborhoods>) {
  return result.facts.candidateNeighborhoods?.flatMap((group) => group.rows) ?? [];
}

test("unique and unresolved failures → no ambiguous neighborhoods", () => {
  const failures = [
    failure({ kind: "found", scope: "local", newLine: 2, newHash: "NEW" }),
    failure({ kind: "none" }),
  ];
  for (const text of ["a\nb\nc\n", ""]) {
    assert.deepEqual(neighborhoods(text, failures), { facts: {}, shownLines: new Set() });
  }
});

test("ambiguous CRLF and BOM context → merges sorted windows with copyable anchors", () => {
  const lines = ["\uFEFFfirst", "a", "", "c", "d", "e", "f", "last"];
  const result = neighborhoods(lines.join("\r\n"), [ambiguous(lines, [6, 2], 6)], 6);
  assert.deepEqual([...result.shownLines], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    result.facts.candidateNeighborhoods?.map((group) => group.lines),
    ["1-8"],
  );
  assert.deepEqual(
    rows(result),
    lines.map(
      (content, index) => `${index + 1}#${computeLineHash(index + 1, content, 6)}│${content}`,
    ),
  );
  assert.doesNotMatch(rows(result).join("\n"), /\r/);
  assert.equal(result.facts.omittedNeighborhoodRows, undefined);
});

test("ambiguous candidates at BOF and EOF → clipped windows without padding", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `${index + 1}`);
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [1, 10])]);
  assert.deepEqual(
    result.facts.candidateNeighborhoods?.map((group) => group.lines),
    ["1-4", "7-10"],
  );
  assert.equal(rows(result).length, 8);
  assert.equal(result.facts.omittedNeighborhoodRows, undefined);
});

test("more than forty context rows and repeated windows → no row cap or duplication", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [4, 14, 24, 34, 44, 54])]);
  assert.equal(rows(result).length, 42);
  assert.equal(result.facts.omittedNeighborhoodRows, undefined);
  const repeated = neighborhoods(
    lines.join("\n"),
    Array.from({ length: 50 }, (_, opIndex) => ({ ...ambiguous(lines, [4, 5]), opIndex })),
  );
  assert.equal(rows(repeated).length, 8);
  assert.equal(new Set(rows(repeated)).size, 8);
});

test("more than eight ambiguous candidates → context uses the same candidate prefix", () => {
  const lines = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`);
  const result = neighborhoods(lines.join("\n"), [
    ambiguous(lines, [4, 14, 24, 34, 44, 54, 64, 74, 84]),
  ]);
  assert.equal(rows(result).length, 56);
  assert.ok(rows(result).some((row) => /^77#[0-9A-Z]+│line-77$/.test(row)));
  assert.ok(rows(result).every((row) => !/^8[1-7]#/.test(row)));
});

test("neighborhood exceeds byte budget → whole rows and explicit omission counts", () => {
  const exact = "x".repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes - Buffer.byteLength("1#XXXX│\n"));
  const cases = [
    { lines: [exact, "target", "last"], shown: [1], omitted: 2 },
    { lines: ["界".repeat(6000), "target", "last"], shown: [2, 3], omitted: 1 },
    { lines: ["short", "界".repeat(6000), "target", "last"], shown: [1, 3, 4], omitted: 1 },
    {
      lines: [
        "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes),
        "y".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes),
      ],
      shown: [],
      omitted: 2,
    },
  ];
  for (const { lines, shown, omitted } of cases) {
    const result = neighborhoods(lines.join("\n"), [
      ambiguous(lines, [lines.length - 1, lines.length]),
    ]);
    assert.deepEqual([...result.shownLines], shown);
    assert.equal(result.facts.omittedNeighborhoodRows, omitted);
    assert.ok(
      Buffer.byteLength(rows(result).join("\n") + (rows(result).length ? "\n" : "")) <=
        DEFAULT_OUTPUT_BUDGETS.blockBytes,
    );
    for (const position of shown)
      assert.ok(
        rows(result).includes(
          `${position}#${computeLineHash(position, lines[position - 1], 4)}│${lines[position - 1]}`,
        ),
      );
  }
});

test("candidate complete row at its byte limit → kept exactly or omitted whole", () => {
  for (const extra of [0, 1]) {
    const candidate = "x".repeat(
      DEFAULT_OUTPUT_BUDGETS.fieldBytes - Buffer.byteLength("2#XXXXXX│") + extra,
    );
    const lines = ["prefix", candidate, "tail", "other"];
    const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [2, 4], 6)], 6);
    assert.equal(result.shownLines.has(2), extra === 0);
    assert.equal(result.facts.omittedNeighborhoodRows, extra === 0 ? undefined : 1);
    assert.ok(result.shownLines.has(4));
  }
});

test("unique candidate inside ambiguous context exceeds limit → context cannot bypass its row limit", () => {
  const lines = ["prefix", "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes), "match", "match"];
  const result = neighborhoods(lines.join("\n"), [
    ambiguous(lines, [3, 4]),
    failure({
      kind: "found",
      scope: "local",
      newLine: 2,
      newHash: computeLineHash(2, lines[1], 4),
    }),
  ]);
  assert.equal(result.shownLines.has(2), false);
  assert.equal(result.facts.omittedNeighborhoodRows, 1);
});

test("remaining context budget cannot fit an intermediate row → retain shorter later rows", () => {
  const lines = [
    "x".repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes - 100),
    "y".repeat(200),
    "target",
    "other",
  ];
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [3, 4])]);
  assert.deepEqual([...result.shownLines], [1, 3, 4]);
  assert.equal(result.facts.omittedNeighborhoodRows, 1);
  assert.ok(Buffer.byteLength(rows(result).join("\n") + "\n") <= DEFAULT_OUTPUT_BUDGETS.blockBytes);
});

function rejectedEdit(text: string, edits: Edit[], shiftRadius = 0) {
  const result = applyEdits(text, edits, DEFAULT_CONFIG.hashLen, shiftRadius);
  assert.ok(!result.ok, "the fixture must reach failure reporting");
  const error = describeEditFailure(
    result.failure,
    { currentText: text, anchors: createAnchorFormatter(DEFAULT_CONFIG.hashLen) },
    edits.length > 1,
  );
  return {
    failure: result.failure,
    report: describeFailure("edit", error, { path: "file.txt", mutation: true }),
  };
}
const oldAnchor = { line: 1, hash: computeLineHash(1, "old", DEFAULT_CONFIG.hashLen) };

test("multiple unresolved anchors and candidate context → one recovery survives omitted facts", () => {
  const cases = [
    ...[2, DEFAULT_OUTPUT_BUDGETS.blockBytes].map((count) => ({
      text: "current\n",
      edits: Array.from({ length: count }, (): Edit => ({ op: "delete", start: oldAnchor })),
      radius: 0,
      omitted: count === DEFAULT_OUTPUT_BUDGETS.blockBytes,
    })),
    {
      text: "current\nold\n",
      edits: [{ op: "delete", start: oldAnchor } as Edit],
      radius: 2,
      omitted: false,
    },
    {
      text: "current\nold\nold\n",
      edits: [{ op: "delete", start: oldAnchor } as Edit],
      radius: 2,
      omitted: false,
    },
  ];
  for (const fixture of cases) {
    const { report } = rejectedEdit(fixture.text, fixture.edits, fixture.radius);
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.match(report.next ?? "", /confirm.*intended target/);
    assert.match(report.next ?? "", /read or grep.*omitted rows.*out-of-range lines.*context/);
    const { next, ...facts } = report;
    assert.equal(renderReport(report).split(next!).length - 1, 1);
    assert.doesNotMatch(JSON.stringify(facts), /\b(?:confirm|read|grep|retries)\b/i);
    if (fixture.radius === 0)
      assert.match(report.failures?.[0].observed ?? "", /1#[0-9A-Z]+│current/);
    assert.equal(Boolean(report.omittedFailures), fixture.omitted);
  }
});

test("failure list exceeds budget → omitted anchors are never reported as matched", () => {
  const { report } = rejectedEdit(
    "current\n",
    Array.from({ length: DEFAULT_OUTPUT_BUDGETS.blockBytes }, () => ({
      op: "delete",
      start: oldAnchor,
    })),
  );
  assert.equal(report.error, "ANCHOR_MISMATCH");
  assert.ok(report.failures && report.failures.length > 0);
  assert.equal(
    report.failures.length + (report.omittedFailures ?? 0),
    DEFAULT_OUTPUT_BUDGETS.blockBytes,
  );
  assert.equal(report.matched, undefined);
  assert.ok(report.failures.every((entry) => entry.result === "unresolved"));
});

test("reversed ranges and overlapping edits → original reason and unpublished status without anchor recovery", () => {
  const text = "a\nb\nc\n";
  const anchor = (line: number, content: string) => ({
    line,
    hash: computeLineHash(line, content, DEFAULT_CONFIG.hashLen),
  });
  const cases: Edit[][] = [
    [{ op: "delete", start: anchor(3, "c"), end: anchor(1, "a") }],
    [
      { op: "delete", start: anchor(1, "a"), end: anchor(2, "b") },
      { op: "replace", start: anchor(2, "b"), body: ["changed"] },
    ],
  ];
  for (const edits of cases) {
    const { failure, report } = rejectedEdit(text, edits);
    assert.ok(failure.kind === "range");
    assert.equal(report.message, failure.message);
    assert.equal(report.publication, "NOT_PUBLISHED");
    assert.doesNotMatch(report.next ?? "", /Before reusing|confirm|read or grep|Retries verify/);
  }
});

test("unresolved row out of range or oversized → omission facts contain no recovery instructions", () => {
  const text = "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes) + "\n";
  const cases = [
    {
      start: oldAnchor,
      reason: new RegExp(`row exceeds ${formatKiB(DEFAULT_OUTPUT_BUDGETS.fieldBytes)}`),
    },
    { start: { ...oldAnchor, line: 2 }, reason: /cited line is out of range/ },
  ];
  for (const { start, reason } of cases) {
    const { report } = rejectedEdit(text, [{ op: "delete", start }]);
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.match(report.failures?.[0].omitted ?? "", reason);
    assert.equal(report.failures?.[0].observed, undefined);
    assert.doesNotMatch(
      JSON.stringify(report.failures),
      /\b(?:confirm|read|grep|retry|retries)\b/i,
    );
  }
});

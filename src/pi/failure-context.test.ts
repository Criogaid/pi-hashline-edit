import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import { applyEdits } from "../core/apply.ts";
import { HashlineError } from "../core/errors.ts";
import type { AnchorFailure, Edit } from "../core/types.ts";
import { formatByteSize, outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
import { DEFAULT_CONFIG } from "./tool-factories.testing.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { describeEditFailure } from "./failure-context.ts";
import { describeMutationFailure } from "./mutation-result.ts";
import { renderReport } from "./report.ts";

function failure(recovery: AnchorFailure["recovery"]): AnchorFailure {
  return {
    opIndex: 0,
    which: "anchor",
    op: "replace",
    cited: { line: 1, hash: "OLD" },
    recovery,
  };
}
function ambiguous(lines: readonly string[], positions: number[], hashLen = 4): AnchorFailure {
  return failure({
    kind: "ambiguous",
    candidates: positions.map((line) => ({
      line,
      hash: computeLineHash(line, lines[line - 1], hashLen),
    })),
  });
}
function neighborhoods(text: string, failures: readonly AnchorFailure[], hashLen = 4) {
  const error = describeEditFailure(
    text,
    failures,
    createAnchorFormatter(hashLen),
    DEFAULT_OUTPUT_BUDGETS,
  );
  assert.equal(error.errorCode, "ANCHOR_MISMATCH");
  assert.ok(error.facts);
  assert.equal(error.facts.failures.length, failures.length);
  assert.equal(error.facts.omittedFailures, undefined);
  return error.facts;
}
function rows(result: ReturnType<typeof neighborhoods>) {
  return result.candidateNeighborhoods?.flatMap((group) => group.rows) ?? [];
}

test("unique and unresolved failures → no ambiguous neighborhoods", () => {
  for (const { text, failures } of [
    {
      text: "a\nb\nc\n",
      failures: [failure({ kind: "found", newLine: 2, newHash: "NEW" }), failure({ kind: "none" })],
    },
    { text: "", failures: [failure({ kind: "none" })] },
  ]) {
    const facts = neighborhoods(text, failures);
    assert.equal(facts.candidateNeighborhoods, undefined);
    assert.equal(facts.omittedNeighborhoodRows, undefined);
  }
});

test("ambiguous CRLF and BOM context → merges sorted windows with copyable anchors", () => {
  const lines = ["\uFEFFfirst", "a", "", "c", "d", "e", "f", "last"];
  const result = neighborhoods(lines.join("\r\n"), [ambiguous(lines, [6, 2], 6)], 6);
  assert.deepEqual(
    result.candidateNeighborhoods?.map((group) => group.lines),
    ["1-8"],
  );
  assert.deepEqual(
    rows(result),
    lines.map(
      (content, index) => `${index + 1}#${computeLineHash(index + 1, content, 6)}│${content}`,
    ),
  );
  assert.doesNotMatch(rows(result).join("\n"), /\r/);
  assert.equal(result.omittedNeighborhoodRows, undefined);
});

test("ambiguous candidates at BOF and EOF → clipped windows without padding", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `${index + 1}`);
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [1, 10])]);
  assert.deepEqual(
    result.candidateNeighborhoods?.map((group) => group.lines),
    ["1-4", "7-10"],
  );
  assert.equal(rows(result).length, 8);
  assert.equal(result.omittedNeighborhoodRows, undefined);
});

test("more than forty context rows and repeated windows → no row cap or duplication", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [4, 14, 24, 34, 44, 54])]);
  assert.equal(rows(result).length, 42);
  assert.equal(result.omittedNeighborhoodRows, undefined);
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
    assert.deepEqual(
      rows(result),
      shown.map(
        (position) =>
          `${position}#${computeLineHash(position, lines[position - 1], 4)}│${lines[position - 1]}`,
      ),
    );
    assert.equal(result.omittedNeighborhoodRows, omitted);
    assert.ok(
      Buffer.byteLength(rows(result).join("\n") + (rows(result).length ? "\n" : "")) <=
        DEFAULT_OUTPUT_BUDGETS.blockBytes,
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
    assert.equal(
      rows(result).some((row) => row.startsWith("2#")),
      extra === 0,
    );
    assert.equal(result.omittedNeighborhoodRows, extra === 0 ? undefined : 1);
    assert.ok(rows(result).some((row) => row.startsWith("4#")));
  }
});

test("unique candidate inside ambiguous context exceeds limit → context cannot bypass its row limit", () => {
  const lines = ["prefix", "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes), "match", "match"];
  const result = neighborhoods(lines.join("\n"), [
    ambiguous(lines, [3, 4]),
    failure({
      kind: "found",
      newLine: 2,
      newHash: computeLineHash(2, lines[1], 4),
    }),
  ]);
  assert.equal(
    rows(result).some((row) => row.startsWith("2#")),
    false,
  );
  assert.equal(result.omittedNeighborhoodRows, 1);
});

test("remaining context budget cannot fit an intermediate row → retain shorter later rows", () => {
  const lines = [
    "x".repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes - 100),
    "y".repeat(200),
    "target",
    "other",
  ];
  const result = neighborhoods(lines.join("\n"), [ambiguous(lines, [3, 4])]);
  assert.deepEqual(
    rows(result).map((row) => Number(row.split("#")[0])),
    [1, 3, 4],
  );
  assert.equal(result.omittedNeighborhoodRows, 1);
  assert.ok(Buffer.byteLength(rows(result).join("\n") + "\n") <= DEFAULT_OUTPUT_BUDGETS.blockBytes);
});

function rejectedEdit(
  text: string,
  edits: Edit[],
  shiftRadius = 0,
  budget = DEFAULT_OUTPUT_BUDGETS,
) {
  const result = applyEdits(text, edits, DEFAULT_CONFIG.hashLen, shiftRadius);
  assert.ok(!result.ok, "the fixture must reach failure reporting");
  const error = describeEditFailure(
    text,
    result.failures,
    createAnchorFormatter(DEFAULT_CONFIG.hashLen),
    budget,
  );
  return describeMutationFailure("edit", error, { path: "file.txt", budget });
}
const oldAnchor = { line: 1, hash: computeLineHash(1, "old", DEFAULT_CONFIG.hashLen) };

test("multiple unresolved anchors and candidate context → one recovery survives omitted facts", () => {
  const budget = outputBudgetsFor(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
  const omittedFailureCount = 16;
  const cases = [
    ...[2, omittedFailureCount].map((count) => ({
      text: "current\n",
      edits: Array.from({ length: count }, (): Edit => ({ op: "delete", anchor: oldAnchor })),
      radius: 0,
      omitted: count === omittedFailureCount,
    })),
    {
      text: "current\nold\n",
      edits: [{ op: "delete", anchor: oldAnchor }] satisfies Edit[],
      radius: 2,
      omitted: false,
    },
    {
      text: "current\nold\nold\n",
      edits: [{ op: "delete", anchor: oldAnchor }] satisfies Edit[],
      radius: 2,
      omitted: false,
    },
    ...["gone", "neighbor"].map((content) => ({
      text: "current\nneighbor\nold\nold\n",
      edits: [
        { op: "delete", anchor: oldAnchor },
        {
          op: "delete",
          anchor: {
            line: content === "gone" ? 2 : 1,
            hash: computeLineHash(content === "gone" ? 2 : 1, content, DEFAULT_CONFIG.hashLen),
          },
        },
      ] satisfies Edit[],
      radius: DEFAULT_CONFIG.shiftRadius,
      omitted: false,
    })),
  ];
  for (const fixture of cases) {
    const report = rejectedEdit(fixture.text, fixture.edits, fixture.radius, budget);
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.equal(
      report.next,
      "Confirm a candidate or observed anchor is the intended target before reusing it; otherwise use read or grep.",
    );
    const { next, ...facts } = report;
    assert.equal(renderReport(report).split(next!).length - 1, 1);
    assert.doesNotMatch(JSON.stringify(facts), /\b(?:confirm|read|grep|retries)\b/i);
    if (fixture.radius === 0) {
      assert.ok(
        report.failures?.every((entry) => /1#[0-9A-Z]+│current/.test(entry.observed ?? "")),
      );
      assert.ok(report.failures && report.failures.length > 0);
      assert.equal(report.failures.length + (report.omittedFailures ?? 0), fixture.edits.length);
      assert.ok(report.failures.every((entry) => entry.result === "unresolved"));
    }
    if (fixture.text === "current\nneighbor\nold\nold\n") {
      const row = createAnchorFormatter(DEFAULT_CONFIG.hashLen).row(2, "neighbor");
      assert.ok(report.candidateNeighborhoods?.some((group) => group.rows.includes(row)));
      const entry = report.failures?.[1];
      assert.ok(entry);
      assert.equal(entry.notShown, undefined);
      if (entry.result === "unresolved") assert.equal(entry.observed, row);
      else {
        assert.equal(entry.result, "shifted");
        assert.equal(entry.content, "neighbor");
      }
    }
    assert.equal(Boolean(report.omittedFailures), fixture.omitted);
  }
});

test("overlapping edits → ordered conflict and shared recovery", () => {
  const text = "a\nb\nc\nd\ne\n";
  const anchor = (line: number, content: string) => ({
    line,
    hash: computeLineHash(line, content, DEFAULT_CONFIG.hashLen),
  });
  const cases: { edits: Edit[] }[] = [
    {
      edits: [
        { op: "replace", anchor: anchor(2, "b"), body: ["changed"] },
        { op: "delete", anchor: anchor(4, "d") },
        { op: "delete", anchor: anchor(1, "a"), end: anchor(2, "b") },
      ],
    },
    {
      edits: [
        { op: "insert_after", anchor: anchor(2, "b"), body: ["first"] },
        { op: "delete", anchor: anchor(4, "d") },
        { op: "insert_before", anchor: anchor(3, "c"), body: ["second"] },
      ],
    },
  ];
  for (const { edits } of cases) {
    assert.throws(
      () => applyEdits(text, edits, DEFAULT_CONFIG.hashLen, 0),
      (error: unknown) => {
        assert.ok(error instanceof HashlineError);
        const report = describeMutationFailure("edit", error, {
          path: "file.txt",
          budget: DEFAULT_OUTPUT_BUDGETS,
        });
        assert.equal(report.error, "OVERLAPPING_EDITS");
        assert.deepEqual(report.conflict, ["edits[0]", "edits[2]"]);
        assert.equal(report.message, error.message);
        assert.equal(report.publication, "NOT_PUBLISHED");
        assert.match(report.next ?? "", /one edit per range or position/);
        return true;
      },
    );
  }
});

test("unresolved row out of range or oversized → omission facts contain no recovery instructions", () => {
  const text = "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes) + "\n";
  const cases = [
    {
      anchor: oldAnchor,
      reason: new RegExp(`row exceeds ${formatByteSize(DEFAULT_OUTPUT_BUDGETS.fieldBytes)}`),
    },
    { anchor: { ...oldAnchor, line: 2 }, reason: /cited line is out of range/ },
  ];
  for (const { anchor, reason } of cases) {
    const report = rejectedEdit(text, [{ op: "delete", anchor }]);
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.match(report.failures?.[0].notShown ?? "", reason);
    assert.equal(report.failures?.[0].observed, undefined);
    assert.doesNotMatch(
      JSON.stringify(report.failures),
      /\b(?:confirm|read|grep|retry|retries)\b/i,
    );
  }
});

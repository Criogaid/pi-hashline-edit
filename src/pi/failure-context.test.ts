import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import { applyEdits } from "../core/apply.ts";
import type { AnchorFailure, Edit } from "../core/types.ts";
import { formatKiB, MAX_BLOCK_BYTES, MAX_RECOVERY_CANDIDATE_BYTES } from "./budgets.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { formatAmbiguousCandidateNeighborhoods, formatFailure } from "./failure-context.ts";

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

function format(text: string, failures: readonly AnchorFailure[], hashLen = 4) {
  return formatAmbiguousCandidateNeighborhoods(text, failures, createAnchorFormatter(hashLen));
}

test("unique and unresolved failures produce no neighborhoods", () => {
  const failures = [
    failure({ kind: "found", scope: "local", newLine: 2, newHash: "NEW" }),
    failure({ kind: "none" }),
  ];
  assert.deepEqual(format("a\nb\nc\n", failures), { text: "", shownLines: new Set() });
  assert.deepEqual(format("", [failure({ kind: "none" })]), { text: "", shownLines: new Set() });
});

test("ambiguous context merges and sorts windows with CRLF and BOM-aware anchors", () => {
  const lines = ["\uFEFFfirst", "a", "", "c", "d", "e", "f", "last"];
  const { text: result, shownLines } = format(lines.join("\r\n"), [ambiguous(lines, [6, 2], 6)], 6);
  assert.deepEqual([...shownLines], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(result, /@@ candidate-neighborhood lines 1-8 @@/);
  assert.match(result, /Ambiguous-candidate neighborhoods.*observation only/);
  for (let line = 1; line <= lines.length; line++) {
    const row = `${line}#${computeLineHash(line, lines[line - 1], 6)}│${lines[line - 1]}`;
    assert.equal(result.split(row).length - 1, 1);
  }
  assert.doesNotMatch(result, /\r|omitted|truncated/);
});

test("ambiguous context clips windows at BOF and EOF without padding", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `${index + 1}`);
  const result = format(lines.join("\n"), [ambiguous(lines, [1, 10])]).text;
  assert.match(result, /@@ candidate-neighborhood lines 1-4 @@/);
  assert.match(result, /@@ candidate-neighborhood lines 7-10 @@/);
  assert.equal((result.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 8);
  assert.doesNotMatch(result, /omitted/);
});

test("ambiguous context exceeds forty rows and merges repeated candidate windows", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
  const result = format(lines.join("\n"), [ambiguous(lines, [4, 14, 24, 34, 44, 54])]).text;
  assert.doesNotMatch(result, /omitted|truncated/);
  assert.equal((result.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 42);
  const repeated = format(
    lines.join("\n"),
    Array.from({ length: 50 }, (_, opIndex) => ({ ...ambiguous(lines, [4, 5]), opIndex })),
  ).text;
  assert.equal((repeated.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 8);
  assert.doesNotMatch(repeated, /omitted|truncated/);
});

test("ambiguous context uses the same first eight candidates as the detail list", () => {
  const lines = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`);
  const result = format(lines.join("\n"), [
    ambiguous(lines, [4, 14, 24, 34, 44, 54, 64, 74, 84]),
  ]).text;
  assert.equal((result.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 56);
  assert.match(result, /^77#[0-9A-Z]+│line-77$/m);
  assert.doesNotMatch(result, /^8[1-7]#[0-9A-Z]+│/m);
});

test("ambiguous context preserves complete rows at the byte budget", () => {
  const exact = "x".repeat(MAX_BLOCK_BYTES - Buffer.byteLength("1#XXXX│\n"));
  const lines = [exact, "target", "last"];
  const byteLimited = format(lines.join("\n"), [ambiguous(lines, [2, 3])]).text;
  assert.ok(byteLimited.includes(`1#${computeLineHash(1, exact, 4)}│${exact}\n`));
  assert.match(byteLimited, /Candidate-neighborhood rows: 1\/3; 2 omitted/);
  assert.match(byteLimited, /truncated: byte limit/);
  assert.doesNotMatch(byteLimited, /^2#[0-9A-Z]+│/m);
  const oversizedFirst = ["界".repeat(6000), "target", "last"];
  const skippedFirst = format(oversizedFirst.join("\n"), [ambiguous(oversizedFirst, [2, 3])]).text;
  assert.match(skippedFirst, /Candidate-neighborhood rows: 2\/3; 1 omitted/);
  assert.doesNotMatch(skippedFirst, /^1#[0-9A-Z]+│/m);
  assert.match(skippedFirst, /^2#[0-9A-Z]+│target$/m);
  assert.match(skippedFirst, /^3#[0-9A-Z]+│last$/m);
  const oversizedMiddle = ["short", "界".repeat(6000), "target", "last"];
  const partial = format(oversizedMiddle.join("\n"), [ambiguous(oversizedMiddle, [3, 4])]).text;
  assert.match(partial, /Candidate-neighborhood rows: 3\/4; 1 omitted/);
  assert.doesNotMatch(partial, /^2#[0-9A-Z]+│/m);
  assert.match(partial, /@@ candidate-neighborhood lines 1-1 @@/);
  assert.match(partial, /@@ candidate-neighborhood lines 3-4 @@/);
  const allOversized = ["x".repeat(4096), "y".repeat(4096)];
  const empty = format(allOversized.join("\n"), [ambiguous(allOversized, [1, 2])]).text;
  assert.match(empty, /No complete neighborhood row fits the limits/);
  assert.match(empty, /Candidate-neighborhood rows: 0\/2; 2 omitted/);
});

test("ambiguous context enforces the complete candidate row byte limit", () => {
  for (const extra of [0, 1]) {
    const candidate = "x".repeat(4096 - Buffer.byteLength("2#XXXXXX│") + extra);
    const lines = ["prefix", candidate, "tail", "other"];
    const output = format(lines.join("\n"), [ambiguous(lines, [2, 4], 6)], 6).text;
    if (extra === 0) {
      assert.ok(output.includes(`2#${computeLineHash(2, candidate, 6)}│${candidate}\n`));
      assert.doesNotMatch(output, /omitted/);
    } else {
      assert.match(output, /truncated: candidate row limit/);
      assert.doesNotMatch(output, /^2#[0-9A-Z]+│/m);
      assert.match(output, /^4#[0-9A-Z]+│other$/m);
    }
  }
});

test("unique candidates inside ambiguous neighborhoods retain the candidate row limit", () => {
  const lines = ["prefix", "x".repeat(4096), "match", "match"];
  const output = format(lines.join("\n"), [
    ambiguous(lines, [3, 4]),
    failure({
      kind: "found",
      scope: "local",
      newLine: 2,
      newHash: computeLineHash(2, lines[1], 4),
    }),
  ]).text;
  assert.match(output, /truncated: candidate row limit/);
  assert.doesNotMatch(output, /^2#[0-9A-Z]+│/m);
});

test("neighborhoods keep shorter later rows when the remaining budget cannot fit a row", () => {
  const lines = ["x".repeat(MAX_BLOCK_BYTES - 100), "y".repeat(200), "target", "other"];
  const output = format(lines.join("\n"), [ambiguous(lines, [3, 4])]);
  assert.deepEqual([...output.shownLines], [1, 3, 4]);
  assert.match(output.text, /Candidate-neighborhood rows: 3\/4; 1 omitted/);
  const rows = output.text.match(/^\d+#[0-9A-Z]+│.*$/gm) ?? [];
  assert.ok(Buffer.byteLength(rows.join("\n") + "\n") <= MAX_BLOCK_BYTES);
});

function rejectedEdit(text: string, edits: Edit[], shiftRadius = 0) {
  const result = applyEdits(text, edits, DEFAULT_CONFIG.hashLen, shiftRadius);
  assert.ok(!result.ok, "the fixture must reach failure formatting");
  return {
    failure: result.failure,
    message: formatFailure(
      result.failure,
      { currentText: text, anchors: createAnchorFormatter(DEFAULT_CONFIG.hashLen) },
      edits.length > 1,
    ),
  };
}

const oldAnchor = { line: 1, hash: computeLineHash(1, "old", DEFAULT_CONFIG.hashLen) };

test("multiple unresolved anchors and candidate context → one closing recovery instruction survives truncation", () => {
  const cases: {
    readonly text: string;
    readonly edits: Edit[];
    readonly radius: number;
    readonly truncated: boolean;
  }[] = [
    ...[2, MAX_BLOCK_BYTES].map((count) => ({
      text: "current\n",
      edits: Array.from({ length: count }, (): Edit => ({ op: "delete", start: oldAnchor })),
      radius: 0,
      truncated: count === MAX_BLOCK_BYTES,
    })),
    {
      text: "current\nold\n",
      edits: [{ op: "delete", start: oldAnchor }],
      radius: 2,
      truncated: false,
    },
    {
      text: "current\nold\nold\n",
      edits: [{ op: "delete", start: oldAnchor }],
      radius: 2,
      truncated: false,
    },
  ];
  for (const fixture of cases) {
    const { message } = rejectedEdit(fixture.text, fixture.edits, fixture.radius);
    const instructions = message.match(/^Before reusing .+$/gm) ?? [];
    assert.equal(instructions.length, 1);
    assert.match(instructions[0], /candidate or observed anchor, confirm.*intended target/);
    assert.match(instructions[0], /read or grep.*omitted rows.*out-of-range lines.*context/);
    assert.match(instructions[0], /Retries verify every anchor again\.$/);
    assert.ok(message.endsWith(instructions[0]), "guidance must follow every diagnostic block");
    const facts = message.slice(0, message.lastIndexOf(instructions[0]));
    assert.doesNotMatch(facts, /\b(?:confirm|read|grep|retries)\b/i);
    if (fixture.radius === 0)
      assert.match(facts, /Current cited line \(observation only\):\n1#[0-9A-Z]+│current/);
    assert.equal(/Diagnostic output truncated/.test(message), fixture.truncated);
  }
});

test("anchor-check rows exceed their byte budget → header qualification and omission warning survive", () => {
  const { message } = rejectedEdit(
    "current\n",
    Array.from({ length: MAX_BLOCK_BYTES }, () => ({ op: "delete", start: oldAnchor })),
  );
  const header = /^Input-anchor checks \(checksum only; this snapshot\):$/m.exec(message);
  assert.ok(header);
  const notice = /Anchor-check output truncated.*omitted entries are not implied matched/.exec(
    message,
  );
  assert.ok(notice);
  assert.ok(header.index < notice.index);
  const rows =
    message.slice(header.index, notice.index).match(/^op \d+ \/ anchor \/ .* \/ mismatched$/gm) ??
    [];
  assert.ok(rows.length > 0 && rows.length < MAX_BLOCK_BYTES);
});

test("reversed ranges and overlapping edits → preserve the core reason and state that nothing was written", () => {
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
    const { failure, message } = rejectedEdit(text, edits);
    assert.ok(failure.kind === "range");
    assert.equal(message.split("\n")[0], failure.message);
    assert.equal(message.split("\n")[1], "No changes written by this edit batch.");
    assert.doesNotMatch(message, /Before reusing|confirm|read or grep|Retries verify/);
  }
});

test("unresolved rows are out of range or oversized → failure entries contain omission facts without instructions", () => {
  const text = "x".repeat(MAX_RECOVERY_CANDIDATE_BYTES) + "\n";
  const cases = [
    {
      start: oldAnchor,
      reason: new RegExp(`Current row exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}`),
    },
    { start: { ...oldAnchor, line: 2 }, reason: /Cited line is out of range/ },
  ];
  for (const { start, reason } of cases) {
    const { message } = rejectedEdit(text, [{ op: "delete", start }]);
    const facts = message.slice(0, message.lastIndexOf("\nBefore reusing "));
    assert.match(facts, reason);
    assert.doesNotMatch(facts, /\b(?:confirm|read|grep|retry|retries)\b/i);
    assert.doesNotMatch(facts, /^\d+#[0-9A-Z]+│/m);
  }
});

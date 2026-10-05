import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { formatMutationAnchors, generateMutationDetails } from "./mutation-result.ts";
import { createAnchorFormatter, displayCarriageReturns } from "./anchor-format.ts";
import { byteRevision } from "./file-commit.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";

for (const [name, before, after] of [
  ["LF", "guard\nold\ntail\n", "guard\nnew\ntail\n"],
  ["CRLF", "guard\r\nold\r\ntail\r\n", "guard\r\nnew\r\ntail\r\n"],
  ["mixed", "guard\r\nold\ntail", "guard\r\nnew\ntail"],
  ["standalone CR", "guard\nold\rtail", "guard\nnew\rtail"],
  ["ending conversion", "same\r\n", "same\n"],
  ["empty file", "", "created"],
  ["BOM and literal escapes", "\uFEFFguard\nold\\n\\0", "\uFEFFguard\nnew\\n\\0"],
  ["no-op", "unchanged\n", "unchanged\n"],
] as const) {
  test(`mutation evidence preserves raw patch and logical preview for ${name}`, () => {
    const versions = {
      baseRevision: byteRevision(before),
      publishedRevision: byteRevision(after),
      observedRevision: byteRevision(after),
    };
    const publication = before === after ? "NOT_PUBLISHED" : "PUBLISHED";
    const details = generateMutationDetails("file.txt", before, after, versions, publication);
    const raw = generateDiffString(before, after);
    const logical = generateDiffString(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    assert.deepEqual(details, {
      diff: displayCarriageReturns(raw.diff),
      displayDiff: displayCarriageReturns(logical.diff),
      firstChangedLine: raw.firstChangedLine,
      patch: generateUnifiedPatch("file.txt", before, after),
      publication,
      ...versions,
    });
  });
}

test("mutation anchors use the full byte budget when no omission notice is needed", () => {
  const anchors = createAnchorFormatter(4);
  const heading = "Updated anchors:";
  const prefix = `\n${heading}\n`;
  const available = MAX_BLOCK_BYTES - Buffer.byteLength(prefix + anchors.row(1, ""));
  const content = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
  const expected = prefix + anchors.row(1, content);
  assert.equal(Buffer.byteLength(expected), MAX_BLOCK_BYTES);
  const report = formatMutationAnchors([], [content], [0], anchors, heading, new Set([0]));
  assert.equal(report, expected);
});

test("mutation anchors count separators exactly at the byte boundary", () => {
  const anchors = createAnchorFormatter(4);
  const heading = "Updated anchors:";
  const prefix = `\n${heading}\n`;
  const tail = "tail";
  const overhead = Buffer.byteLength(`${prefix}${anchors.row(1, "")}\n${anchors.row(2, tail)}`);
  const lines = ["x".repeat(MAX_BLOCK_BYTES - overhead), tail];
  const expected = prefix + lines.map((line, index) => anchors.row(index + 1, line)).join("\n");
  assert.equal(Buffer.byteLength(expected), MAX_BLOCK_BYTES);
  assert.equal(
    formatMutationAnchors([], lines, [0, 1], anchors, heading, new Set([0, 1])),
    expected,
  );
});

test("mutation anchors reserve the notice after overflow and retain later fitting rows", () => {
  const anchors = createAnchorFormatter(4);
  const heading = "Updated anchors:";
  const overhead = Buffer.byteLength(`\n${heading}\n${anchors.row(1, "")}`);
  for (const extra of [0, 1, MAX_BLOCK_BYTES]) {
    const lines = ["x".repeat(MAX_BLOCK_BYTES - overhead + extra), "short", "last"];
    const report = formatMutationAnchors(
      [],
      lines,
      [0, 1, 2].values(),
      anchors,
      heading,
      new Set([0, 1, 2]),
    );
    assert.ok(Buffer.byteLength(report) <= MAX_BLOCK_BYTES);
    assert.match(report, /additional anchors omitted/);
    assert.ok(!report.includes(anchors.row(1, lines[0])));
    assert.ok(report.includes(`${anchors.row(2, lines[1])}\n${anchors.row(3, lines[2])}`));
  }
});

test("compact mutation anchors have no row cap and stop at the byte budget", () => {
  const anchors = createAnchorFormatter(4);
  for (const count of [80, 3000]) {
    const lines = Array.from({ length: count }, (_, index) => `changed ${index}`);
    const report = formatMutationAnchors([], lines, lines.keys(), anchors, "Updated anchors:");
    const rows = report.match(/^\d+#[0-9A-Z]+$/gm) ?? [];
    assert.ok(rows.length > 40);
    assert.doesNotMatch(report, /│/);
    assert.ok(Buffer.byteLength(report) <= MAX_BLOCK_BYTES);
    if (count === 80) {
      assert.equal(rows.length, count);
      assert.doesNotMatch(report, /omitted/);
    } else {
      assert.ok(rows.length < count);
      assert.match(report, /additional anchors omitted/);
    }
    assert.deepEqual(
      rows,
      lines.slice(0, rows.length).map((line, index) => anchors.token(index + 1, line)),
    );
  }
});

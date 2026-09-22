import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import type { AnchorFailure } from "../core/types.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { formatAmbiguousCandidateNeighborhoods } from "./failure-context.ts";

function failure(recovery: AnchorFailure["recovery"]): AnchorFailure {
	return { opIndex: 0, which: "anchor", op: "replace", cited: { line: 1, hash: "OLD" }, recovery, current: null };
}

function ambiguous(lines: readonly string[], positions: number[], hashLen = 4): AnchorFailure {
	return failure({ kind: "ambiguous", scope: "local", candidates: positions.map(line => ({ line, hash: computeLineHash(line, lines[line - 1], hashLen) })) });
}

function format(text: string, failures: readonly AnchorFailure[], hashLen = 4) {
	return formatAmbiguousCandidateNeighborhoods(text, failures, createAnchorFormatter(hashLen));
}

test("unique and unresolved failures produce no neighborhoods", () => {
	const failures = [failure({ kind: "found", scope: "local", newLine: 2, newHash: "NEW" }), failure({ kind: "none" })];
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
	const repeated = format(lines.join("\n"), Array.from({ length: 50 }, (_, opIndex) => ({ ...ambiguous(lines, [4, 5]), opIndex }))).text;
	assert.equal((repeated.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 8);
	assert.doesNotMatch(repeated, /omitted|truncated/);
});

test("ambiguous context uses the same first eight candidates as the detail list", () => {
	const lines = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`);
	const result = format(lines.join("\n"), [ambiguous(lines, [4, 14, 24, 34, 44, 54, 64, 74, 84])]).text;
	assert.equal((result.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 56);
	assert.match(result, /^77#[0-9A-Z]+│line-77$/m);
	assert.doesNotMatch(result, /^8[1-7]#[0-9A-Z]+│/m);
});

test("ambiguous context preserves complete rows at the byte budget", () => {
	const exact = "x".repeat(16 * 1024 - Buffer.byteLength("1#XXXX│\n"));
	const lines = [exact, "target", "last"];
	const byteLimited = format(lines.join("\n"), [ambiguous(lines, [2, 3])]).text;
	assert.ok(byteLimited.includes(`1#${computeLineHash(1, exact)}│${exact}\n`));
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
		failure({ kind: "found", scope: "local", newLine: 2, newHash: computeLineHash(2, lines[1]) }),
	]).text;
	assert.match(output, /truncated: candidate row limit/);
	assert.doesNotMatch(output, /^2#[0-9A-Z]+│/m);
});

test("neighborhoods keep shorter later rows when the remaining budget cannot fit a row", () => {
	const lines = ["x".repeat(16 * 1024 - 100), "y".repeat(200), "target", "other"];
	const output = format(lines.join("\n"), [ambiguous(lines, [3, 4])]);
	assert.deepEqual([...output.shownLines], [1, 3, 4]);
	assert.match(output.text, /Candidate-neighborhood rows: 3\/4; 1 omitted/);
	const rows = output.text.match(/^\d+#[0-9A-Z]+│.*$/gm) ?? [];
	assert.ok(Buffer.byteLength(rows.join("\n") + "\n") <= 16 * 1024);
});

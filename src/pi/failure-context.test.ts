import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import type { AnchorFailure } from "../core/types.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { formatFailureContext as formatFailureContextWith, formatUniqueCandidateNeighborhoods as formatUniqueCandidateNeighborhoodsWith } from "./failure-context.ts";

function formatFailureContext(text: string, failures: readonly AnchorFailure[], hashLen: number) {
	return formatFailureContextWith(text, failures, createAnchorFormatter(hashLen));
}

function formatUniqueCandidateNeighborhoods(text: string, failures: readonly AnchorFailure[], hashLen: number) {
	return formatUniqueCandidateNeighborhoodsWith(text, failures, createAnchorFormatter(hashLen));
}

function unresolved(line: number): AnchorFailure {
	return {
		opIndex: 0,
		which: "anchor",
		op: "replace",
		cited: { line, hash: "OLD" },
		recovery: { kind: "none" },
		current: null,
	};
}

test("failure context is omitted when every anchor was recovered", () => {
	const found: AnchorFailure = { ...unresolved(2), recovery: { kind: "found", newLine: 3, newHash: "NEW" } };
	assert.equal(formatFailureContext("a\nb\nc\n", [found], 4), "");
});

test("failure context merges adjacent windows and emits each anchored line once", () => {
	const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
	const result = formatFailureContext(`${lines.join("\n")}\n`, [unresolved(5), unresolved(9)], 4);
	assert.match(result, /@@ lines 2-12 @@/);
	assert.doesNotMatch(result, /omitted|Limits:/);
	for (let line = 2; line <= 12; line++) {
		const row = `${line}#${computeLineHash(line, lines[line - 1])}│${lines[line - 1]}`;
		assert.equal(result.split(row).length - 1, 1);
	}
});

test("failure context clamps BOF, EOF, and out-of-range anchors without padding", () => {
	const text = Array.from({ length: 10 }, (_, index) => `${index + 1}`).join("\n");
	const result = formatFailureContext(text, [unresolved(1000), unresolved(-10)], 4);
	assert.match(result, /@@ lines 1-4 @@/);
	assert.match(result, /@@ lines 7-10 @@/);
	assert.doesNotMatch(result, /omitted/);
});

test("failure context returns no invented anchor for an empty file", () => {
	const result = formatFailureContext("", [unresolved(1)], 4);
	assert.match(result, /file is empty/i);
	assert.doesNotMatch(result, /\d+#[0-9A-Z]+│/);
});

test("failure context keeps the lowest 40 rows and reports row truncation", () => {
	const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
	const result = formatFailureContext(text, [4, 20, 36, 52, 68, 84].map(unresolved), 4);
	assert.match(result, /Context rows: 40\/42; 2 omitted/);
	assert.match(result, /Context truncated: row limit/);
	assert.match(result, /85#[0-9A-Z]+│line 85/);
	assert.doesNotMatch(result, /86#[0-9A-Z]+│line 86/);
});

test("failure context never truncates or skips an oversized first row", () => {
	const oversized = "界".repeat(16 * 1024);
	const result = formatFailureContext(`${oversized}\nshort\n`, [unresolved(1)], 4);
	assert.match(result, /No context row fits the byte budget/);
	assert.match(result, /Context rows: 0\/2; 2 omitted/);
	assert.match(result, /Context truncated: byte limit/);
	assert.doesNotMatch(result, /│short/);
});

test("failure context accepts an exact 16 KiB row and then stops at the next row", () => {
	const exact = "x".repeat(16 * 1024 - 10);
	const result = formatFailureContext(`${exact}\nlater\n`, [unresolved(1)], 4);
	assert.match(result, /Context rows: 1\/2; 1 omitted/);
	assert.match(result, /Context truncated: byte limit/);
	assert.match(result, new RegExp(`1#${computeLineHash(1, exact)}│x`));
	assert.doesNotMatch(result, /│later/);
});

test("failure context stops at an oversized middle row without skipping it", () => {
	const oversized = "界".repeat(16 * 1024);
	const result = formatFailureContext(`short\n${oversized}\nlater\n`, [unresolved(2)], 4);
	assert.match(result, /1#[0-9A-Z]+│short/);
	assert.match(result, /Context rows: 1\/3; 2 omitted/);
	assert.doesNotMatch(result, /3#[0-9A-Z]+│later/);
});

test("failure context hashes canonical CRLF lines with the captured hash length", () => {
	const result = formatFailureContext("alpha\r\n\r\nomega\r\n", [unresolved(2)], 6);
	assert.match(result, new RegExp(`1#${computeLineHash(1, "alpha", 6)}│alpha`));
	assert.match(result, new RegExp(`2#${computeLineHash(2, "", 6)}│(?:\\n|$)`));
	assert.match(result, new RegExp(`3#${computeLineHash(3, "omega", 6)}│omega`));
});

function found(lines: readonly string[], line: number, hashLen = 4): AnchorFailure {
	return { ...unresolved(line), recovery: { kind: "found", newLine: line, newHash: computeLineHash(line, lines[line - 1], hashLen) } };
}

test("unique candidate context merges windows with full CRLF and BOM-aware anchors", () => {
	const lines = ["\uFEFFfirst", "a", "b", "c", "d", "e", "f", "last"];
	const { text: result, shownLines } = formatUniqueCandidateNeighborhoods(lines.join("\r\n"), [found(lines, 2, 6), found(lines, 6, 6)], 6);
	assert.deepEqual([...shownLines], [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.match(result, /@@ candidate-neighborhood lines 1-8 @@/);
	assert.match(result, /observation only/);
	for (let line = 1; line <= lines.length; line++) {
		const row = `${line}#${computeLineHash(line, lines[line - 1], 6)}│${lines[line - 1]}`;
		assert.equal(result.split(row).length - 1, 1);
	}
	assert.doesNotMatch(result, /\r/);
	assert.deepEqual(formatUniqueCandidateNeighborhoods(lines.join("\n"), [unresolved(3)], 4), { text: "", shownLines: new Set() });
	assert.equal(formatUniqueCandidateNeighborhoods(lines.join("\n"), [{ ...unresolved(3), recovery: { kind: "ambiguous", candidates: [{ line: 2, hash: "ABCD" }, { line: 6, hash: "EFGH" }] } }], 4).text, "");
});

test("unique candidate context bounds rows and merges repeated candidate windows", () => {
	const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
	const result = formatUniqueCandidateNeighborhoods(lines.join("\n"), [4, 14, 24, 34, 44, 54].map((line) => found(lines, line)), 4).text;
	assert.match(result, /Candidate-neighborhood rows: 40\/42; 2 omitted/);
	assert.match(result, /truncated: row limit/);
	assert.equal((result.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 40);
	const repeated = formatUniqueCandidateNeighborhoods(lines.join("\n"), Array.from({ length: 50 }, (_, opIndex) => ({ ...found(lines, 4), opIndex })), 4).text;
	assert.equal((repeated.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 7);
	assert.doesNotMatch(repeated, /Candidate op|omitted/);
});

test("unique candidate context keeps complete rows at byte and candidate limits", () => {
	const exact = "x".repeat(16 * 1024 - Buffer.byteLength("1#XXXX│\n"));
	const lines = [exact, "target", "last"];
	const byteLimited = formatUniqueCandidateNeighborhoods(lines.join("\n"), [found(lines, 2)], 4).text;
	assert.ok(byteLimited.includes(`1#${computeLineHash(1, exact)}│${exact}\n`));
	assert.match(byteLimited, /Candidate-neighborhood rows: 1\/3; 2 omitted/);
	assert.match(byteLimited, /truncated: byte limit/);
	assert.doesNotMatch(byteLimited, /^2#[0-9A-Z]+│/m);
	const multibyte = ["short", "界".repeat(6000), "target"];
	const tooLarge = formatUniqueCandidateNeighborhoods(multibyte.join("\n"), [found(multibyte, 3)], 4).text;
	assert.match(tooLarge, /Candidate-neighborhood rows: 1\/3; 2 omitted/);
	assert.doesNotMatch(tooLarge, /^2#[0-9A-Z]+│/m);
	for (const extra of [0, 1]) {
		const candidate = "x".repeat(4096 - Buffer.byteLength("2#XXXXXX│") + extra);
		const text = ["prefix", candidate, "tail"];
		const output = formatUniqueCandidateNeighborhoods(text.join("\n"), [found(text, 2, 6)], 6).text;
		if (extra === 0) {
			assert.ok(output.includes(`2#${computeLineHash(2, candidate, 6)}│${candidate}\n`));
			assert.doesNotMatch(output, /omitted/);
		} else {
			assert.match(output, /truncated: candidate row limit/);
			assert.doesNotMatch(output, /^2#[0-9A-Z]+│/m);
		}
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import type { AnchorFailure } from "../core/types.ts";
import { formatFailureContext } from "./failure-context.ts";

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
	assert.match(result, /Context rows: 11\/11; 0 omitted/);
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
	assert.match(result, /Context rows: 8\/8; 0 omitted/);
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

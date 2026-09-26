/**
 * Micro-benchmarks for core operations in pi-hashline-edit.
 * Measures throughput for line splitting, FNV-1a hashing, and edit application.
 */

import { performance } from "node:perf_hooks";
import { splitLines, createLfTextView } from "../src/core/lines.ts";
import { computeLineHash, hashFileLines } from "../src/core/hash.ts";
import { applyEdits } from "../src/core/apply.ts";
import type { Edit } from "../src/core/types.ts";
import { submatchesToLineRanges } from "../src/pi/rg-line-ranges.ts";

function bench(name: string, iterations: number, fn: () => void): void {
	// Warm up
	for (let i = 0; i < Math.min(iterations, 5); i++) fn();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) fn();
	const durationMs = performance.now() - start;
	const avgMs = durationMs / iterations;
	const opsPerSec = Math.round((iterations / (durationMs / 1000)));
	console.log(`- ${name}: ${avgMs.toFixed(3)} ms/iter (${opsPerSec.toLocaleString()} ops/sec)`);
}

console.log("=== pi-hashline-edit Performance Benchmarks ===\n");

// 1. splitLines on LF and CRLF fixtures (50,000 lines)
const LINE_COUNT = 50_000;
const lfText = "const x = 123;\nfunction test() { return 42; }\n".repeat(LINE_COUNT / 2);
const crlfText = "const x = 123;\r\nfunction test() { return 42; }\r\n".repeat(LINE_COUNT / 2);

console.log(`[1. Line Splitting (${LINE_COUNT.toLocaleString()} lines)]`);
bench("splitLines (LF text)", 20, () => {
	splitLines(lfText);
});
bench("splitLines (CRLF text)", 20, () => {
	splitLines(crlfText);
});

// 2. computeLineHash & hashFileLines
const sampleLines = splitLines(lfText);
console.log(`\n[2. Content Hashing (${sampleLines.length.toLocaleString()} lines)]`);
bench("hashFileLines (50,000 lines, hashLen=4)", 10, () => {
	hashFileLines(sampleLines, 4);
});
bench("computeLineHash (single line)", 100_000, () => {
	computeLineHash(1234, "export const configurationKey = 'hashlineEdit.enabled';", 4);
});
bench("computeLineHash (blank line)", 100_000, () => {
	computeLineHash(1234, "", 4);
});

// 3. createLfTextView offset mapping (10,000 lines CRLF)
const crlfSample = "const line = 'value';\r\n".repeat(10_000);
console.log("\n[3. CRLF LF-View Mapping (10,000 lines)]");
bench("createLfTextView creation", 50, () => {
	createLfTextView(crlfSample);
});

// 4. applyEdits batch application (5,000 lines, 20 edits)
const file5k = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const lines5k = splitLines(file5k);
const edits: Edit[] = [];
for (let i = 100; i < 200; i += 5) {
	edits.push({
		op: "replace",
		start: { line: i, hash: computeLineHash(i, lines5k[i - 1], 4) },
		body: [`updated line ${i}`],
	});
}
console.log("\n[4. Edit Application (5,000 lines, 20 edits)]");
bench("applyEdits batch verification and application", 50, () => {
	applyEdits(file5k, edits, 4);
});

// 5. Prefix hits must not scan the remainder of a long physical line.
const longLine = Buffer.alloc(4 * 1024 * 1024, 120);
longLine.write("a ".repeat(100));
const prefixHits = Array.from({ length: 100 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }));
console.log("\n[5. Long-line Range Mapping (4 MiB, 100 prefix hits)]");
bench("submatchesToLineRanges", 100, () => {
	submatchesToLineRanges(longLine, 1, prefixHits, 1);
});

console.log("\nAll benchmarks completed successfully.");

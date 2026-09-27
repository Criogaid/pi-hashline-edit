import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { generateMutationDetails } from "./mutation-result.ts";
import { displayCarriageReturns } from "./anchor-format.ts";
import { byteRevision } from "./file-commit.ts";

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
		const versions = { baseRevision: byteRevision(before), publishedRevision: byteRevision(after), observedRevision: byteRevision(after) };
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
			revision: versions.publishedRevision,
		});
	});
}

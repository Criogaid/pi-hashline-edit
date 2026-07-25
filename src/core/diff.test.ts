import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiff } from "./diff.ts";

test("single hunk", () => {
	const d = buildDiff("f.ts", ["a", "b", "c"], [{ lo: 1, hi: 2, newLines: ["X"] }]);
	assert.ok(d.startsWith("--- a/f.ts\n"));
	assert.ok(d.includes("+++ b/f.ts"));
	assert.ok(d.includes("@@ -2 +2 @@"));
	assert.ok(d.includes("-b"));
	assert.ok(d.includes("+X"));
});

test("multi-line range hunk carries counts", () => {
	const d = buildDiff("f", ["a", "b", "c", "d"], [{ lo: 0, hi: 3, newLines: ["X"] }]);
	assert.ok(d.includes("@@ -1,3 +1 @@")); // newCount=1 omits the count (git convention)
});

test("empty ops returns empty string", () => {
	assert.equal(buildDiff("f", ["a"], []), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiff } from "./diff.ts";

test("单 hunk", () => {
	const d = buildDiff("f.ts", ["a", "b", "c"], [{ lo: 1, hi: 2, newLines: ["X"] }]);
	assert.ok(d.startsWith("--- a/f.ts\n"));
	assert.ok(d.includes("+++ b/f.ts"));
	assert.ok(d.includes("@@ -2 +2 @@"));
	assert.ok(d.includes("-b"));
	assert.ok(d.includes("+X"));
});

test("多行 range hunk 带计数", () => {
	const d = buildDiff("f", ["a", "b", "c", "d"], [{ lo: 0, hi: 3, newLines: ["X"] }]);
	assert.ok(d.includes("@@ -1,3 +1 @@")); // newCount=1 时省略计数（git 惯例）
});

test("空 ops 返回空串", () => {
	assert.equal(buildDiff("f", ["a"], []), "");
});

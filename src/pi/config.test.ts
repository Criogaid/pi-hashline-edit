import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("actionFusion defaults on and honors explicit disabling", async () => {
	const root = await mkdtemp(join(tmpdir(), "hashline-config-"));
	try {
		await mkdir(join(root, ".pi"));
		for (const [actionFusion, expected] of [[undefined, true], [false, false], [true, true], [null, true], ["false", true], [0, true]]) {
			await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { actionFusion } }));
			assert.deepEqual(loadConfig(root), { enabled: true, actionFusion: expected, hashLen: 4, shiftRadius: 15 });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("config rejects fractional values and tolerates malformed settings shapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "hashline-config-"));
	try {
		await mkdir(join(root, ".pi"));
		const path = join(root, ".pi", "settings.json");
		for (const value of [3.5, -1, "4", null]) {
			await writeFile(path, JSON.stringify({ hashlineEdit: { hashLen: value, shiftRadius: value } }));
			assert.deepEqual(loadConfig(root), { enabled: true, actionFusion: true, hashLen: 4, shiftRadius: 15 });
		}
		for (const rootValue of [null, [], 42, "settings", { hashlineEdit: [] }, { hashlineEdit: "invalid" }]) {
			await writeFile(path, JSON.stringify(rootValue));
			const config = loadConfig(root);
			assert.ok(Number.isInteger(config.hashLen));
			assert.ok(Number.isInteger(config.shiftRadius));
		}
		await writeFile(path, JSON.stringify({ hashlineEdit: { hashLen: 8, shiftRadius: 0 } }));
		assert.equal(loadConfig(root).hashLen, 8);
		assert.equal(loadConfig(root).shiftRadius, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

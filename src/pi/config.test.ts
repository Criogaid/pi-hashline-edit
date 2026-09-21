import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("actionFusion defaults off and can be enabled without changing other defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "hashline-config-"));
	try {
		await mkdir(join(root, ".pi"));
		await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: {} }));
		assert.equal(loadConfig(root).actionFusion, false);
		await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { actionFusion: true } }));
		const config = loadConfig(root);
		assert.equal(config.actionFusion, true);
		assert.equal(config.hashLen, 4);
		assert.equal(config.shiftRadius, 15);
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
			assert.deepEqual(loadConfig(root), { enabled: true, actionFusion: false, hashLen: 4, shiftRadius: 15 });
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

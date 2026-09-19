import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("actionFusion defaults off and can be enabled without changing other defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "hashline-config-"));
	try {
		assert.equal(loadConfig(root).actionFusion, false);
		await mkdir(join(root, ".pi"));
		await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { actionFusion: true } }));
		const config = loadConfig(root);
		assert.equal(config.actionFusion, true);
		assert.equal(config.hashLen, 4);
		assert.equal(config.shiftRadius, 15);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import registerHashline from "../index.ts";
import { getState } from "./state.ts";

test("enabled registration installs the Hashline write and shared Fusion schemas", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hashline-registration-"));
	const previousCwd = process.cwd();
	const state = getState();
	const previousConfig = state.config;
	try {
		await mkdir(join(dir, ".pi"));
		await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { enabled: true, actionFusion: true } }));
		process.chdir(dir);
		const tools: any[] = [];
		const entries: any[] = [];
		registerHashline({
			on() {},
			registerEntryRenderer() {},
			appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
			registerTool(tool: any) { tools.push(tool); },
		} as any);
		assert.deepEqual(tools.map((tool) => tool.name), ["write", "edit", "replace", "read", "grep"]);
		for (const tool of tools.filter((tool) => ["edit", "replace", "write"].includes(tool.name))) {
			assert.ok(tool.parameters.properties.then_run, `${tool.name} should expose then_run when actionFusion is enabled`);
		}
		const writeTool = tools.find((tool) => tool.name === "write");
		const result = await writeTool.execute("write-error", { path: "published.txt", content: "published\n", then_run: { command: "node -e \\\"process.exit(1)\\\"" } }, undefined, undefined, { cwd: dir });
		assert.equal(result.details.actionFusion.command, "failed");
		assert.match(result.content[1].text, /File changes are saved[\s\S]*Command failed/);
		assert.deepEqual(entries.map((entry) => entry.data.command), ["waiting", "failed"]);
		assert.equal(entries[1].data.publication, "PUBLISHED");
	} finally {
		process.chdir(previousCwd);
		state.config = previousConfig;
		await rm(dir, { recursive: true, force: true });
	}
});

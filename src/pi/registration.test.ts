import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import registerHashline from "../index.ts";
import { getState } from "./state.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("registered mutation cards finish independently of fused command cards", async () => {
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
		const renderers = new Map<string, any>();
		registerHashline({
			on() {},
			registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
			appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
			registerTool(tool: any) { tools.push(tool); },
		} as any);
		assert.deepEqual(tools.map((tool) => tool.name), ["write", "edit", "replace", "read", "grep"]);
		for (const tool of tools.filter((tool) => ["edit", "replace", "write"].includes(tool.name))) {
			assert.ok(tool.parameters.properties.then_run, `${tool.name} should expose then_run when actionFusion is enabled`);
		}
		initTheme("dark");
		const cases = [
			{ name: "write", args: { content: "published\n" } },
			{ name: "edit", args: { edits: [{ op: "append", body: ["appended"] }] } },
			{ name: "replace", args: { find: "published", replace: "published" } },
		];
		for (const { name, args } of cases) {
			const tool = tools.find((tool) => tool.name === name);
			const params = { path: "published.txt", ...args, then_run: { command: "exit 7" } };
			const card = new ToolExecutionComponent(name, name, params, {}, tool, { requestRender() {} } as any, dir);
			card.setArgsComplete();
			card.markExecutionStarted();
			const frames: { command: string; publication: string; mutationCompleted: boolean; output: string; commandOutput: string }[] = [];
			const result = await tool.execute(name, params, undefined, (update: any) => {
				card.updateResult({ ...update, isError: false }, true);
				const entry = entries.find((entry) => entry.customType === "hashline-then-run" && entry.data.toolCallId === name);
				const commandCard = renderers.get(entry.customType)(entry, { expanded: false }, theme);
				frames.push({ ...update.details.actionFusion, output: card.render(100).join("\n"), commandOutput: commandCard.render(100).join("\n") });
			}, { cwd: dir });
			assert.equal(result.details.actionFusion.command, "failed");
			assert.match(result.content[1].text, /File changes are saved|No file changes were published/);
			assert.ok(frames[0].output.includes(theme.getBgAnsi("toolPendingBg")));
			const running = frames.find((frame) => frame.command === "running")!;
			assert.ok(running, `${name} should emit running progress`);
			assert.ok(running.output.includes(theme.getBgAnsi("toolSuccessBg")), `${name} should turn green before then_run ends`);
			assert.ok(!running.output.includes(theme.getBgAnsi("toolPendingBg")));
			assert.ok(running.commandOutput.includes(theme.getBgAnsi("toolPendingBg")));
			assert.ok(frames.at(-1)!.commandOutput.includes(theme.getBgAnsi("toolErrorBg")));
			const completed = frames.find((frame) => frame.command === "waiting" && frame.mutationCompleted)!;
			assert.ok(completed?.output.includes(theme.getBgAnsi("toolSuccessBg")), "mutation completion must repaint before command checks");
			if (name === "replace") assert.equal(running.publication, "NOT_PUBLISHED");
			card.updateResult({ ...result, isError: false });
			assert.ok(card.render(100).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));
			card.setExpanded(true);
			assert.ok(card.render(100).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));

			const invalid = { ...params, path: "missing.txt", ...(name === "write" ? { mode: "overwrite" } : {}) };
			const failedCard = new ToolExecutionComponent(name, `${name}-bad`, invalid, {}, tool, { requestRender() {} } as any, dir);
			await assert.rejects(tool.execute(`${name}-bad`, invalid, undefined, (update: any) => {
				failedCard.updateResult({ ...update, isError: false }, true);
			}, { cwd: dir }), (error: Error) => {
				failedCard.updateResult({ content: [{ type: "text", text: error.message }], isError: true });
				const output = failedCard.render(100).join("\n");
				assert.ok(output.includes(theme.getBgAnsi("toolErrorBg")), `${name} mutation failure should turn red`);
				assert.ok(!output.includes(theme.getBgAnsi("toolPendingBg")));
				return true;
			});
		}
		assert.deepEqual(entries.map((entry) => entry.data.command), cases.flatMap(() => ["waiting", "failed", "waiting", "skipped"]));
	} finally {
		process.chdir(previousCwd);
		state.config = previousConfig;
		await rm(dir, { recursive: true, force: true });
	}
});

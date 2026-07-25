/**
 * pi-hashline-edit 扩展入口。
 *
 * override 内置 read/edit：read 输出「行号#hash│内容」并记录快照，
 * edit 只接受 hashline patch（LINE#HASH 锚），旧 oldText/newText 明确拒绝
 * （不静默降级）。renderer 自动继承内置渲染。
 *
 * @module pi-hashline-edit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./pi/config.ts";
import { clearSnapshots, getState } from "./pi/state.ts";
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// session 启动/重载时刷新配置与快照
	pi.on("session_start", async () => {
		const config = loadConfig(cwd);
		const state = getState();
		state.config = config;
		state.hashLen = config.hashLen;
		clearSnapshots();
	});

	pi.registerTool(makeReadOverride(cwd));
	pi.registerTool(makeEditOverride(cwd));
}

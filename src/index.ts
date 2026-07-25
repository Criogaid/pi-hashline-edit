/**
 * pi-hashline-edit extension entry.
 *
 * Overrides the built-in read/edit: read outputs "lineNo#hash│content";
 * edit accepts structured hashline ops (edits[] with LINE#HASH anchors), and
 * legacy oldText/newText is rejected explicitly (no silent degradation). Each
 * tool carries its own renderer.
 *
 * @module pi-hashline-edit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./pi/config.ts";
import { getState } from "./pi/state.ts";
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// refresh config on session start / reload
	pi.on("session_start", async () => {
		const state = getState();
		state.config = loadConfig(cwd);
	});

	pi.registerTool(makeReadOverride(cwd));
	pi.registerTool(makeEditOverride(cwd));
}

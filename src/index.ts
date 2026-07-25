/**
 * pi-hashline-edit extension entry.
 *
 * Overrides the built-in read/edit: read outputs "lineNo#hash│content" and
 * records a snapshot; edit accepts only a hashline patch (LINE#HASH anchors),
 * and legacy oldText/newText is rejected explicitly (no silent degradation).
 * The renderer is inherited from the built-in automatically.
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

	// refresh config and snapshots on session start / reload
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

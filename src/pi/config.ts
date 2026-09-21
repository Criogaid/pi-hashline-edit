/**
 * Config loading: project `.pi/settings.json` replaces global, per-field `??`
 * falls back to DEFAULT. Config field `hashlineEdit` (drop the `pi-` prefix,
 * camelCase).
 *
 * @module pi-hashline-edit/pi
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export interface HashlineEditConfig {
	/** Master switch: when false the extension registers no tools — pi's built-ins remain. */
	enabled: boolean;
	/** Run an optional command after edit/replace succeeds. Disabled by default. */
	actionFusion: boolean;
	/** Line hash length (default 4). */
	hashLen: number;
	/** ±line radius for shifted-anchor recovery (default 15; 0 disables rescue). */
	shiftRadius: number;
}

const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, actionFusion: false, hashLen: 4, shiftRadius: 15 };

/** Parse JSON directly without stripping comments (standard JSON forbids comments; on error fall back to default). */
function readSettings(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/**
 * Load config. The `hashlineEdit` in project `cwd/.pi/settings.json` replaces
 * the global one wholesale; missing fields fall back to DEFAULT_CONFIG.
 */
export function loadConfig(cwd?: string): HashlineEditConfig {
	const globalSettings = readSettings(path.join(getAgentDir(), "settings.json"));
	const projectSettings = cwd ? readSettings(path.join(cwd, ".pi", "settings.json")) : {};
	const value = projectSettings.hashlineEdit ?? globalSettings.hashlineEdit;
	const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		actionFusion: raw.actionFusion === true,
		hashLen:
			typeof raw.hashLen === "number" && Number.isInteger(raw.hashLen) && raw.hashLen >= 2 && raw.hashLen <= 8
				? raw.hashLen
				: DEFAULT_CONFIG.hashLen,
		shiftRadius:
			typeof raw.shiftRadius === "number" && Number.isInteger(raw.shiftRadius) && raw.shiftRadius >= 0 && raw.shiftRadius <= 100
				? raw.shiftRadius
				: DEFAULT_CONFIG.shiftRadius,
	};
}

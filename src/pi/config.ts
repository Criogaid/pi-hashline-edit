/**
 * Config loading: project `.pi/settings.json` replaces global, per-field `??`
 * falls back to DEFAULT. Config field `hashlineEdit` (drop the `pi-` prefix,
 * camelCase).
 *
 * @module pi-hashline-edit/pi
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HashlineEditConfig {
	/** Whether hashline is enabled (when false, delegate to the built-in read/edit). */
	enabled: boolean;
	/** Line hash length (default 4). */
	hashLen: number;
}

const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, hashLen: 4 };

function getAgentDir(): string {
	const envDir = process.env.PI_AGENT_DIR;
	if (envDir) return envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** Parse JSON directly without stripping comments (standard JSON forbids comments; on error fall back to default). */
function readSettings(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
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
	const raw = (projectSettings.hashlineEdit ?? globalSettings.hashlineEdit ?? {}) as Record<string, unknown>;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		hashLen:
			typeof raw.hashLen === "number" && raw.hashLen >= 2 && raw.hashLen <= 8
				? raw.hashLen
				: DEFAULT_CONFIG.hashLen,
	};
}

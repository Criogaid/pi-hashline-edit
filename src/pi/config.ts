/**
 * 配置加载：项目 `.pi/settings.json` 替换全局，per-field `??` DEFAULT 兜底。
 * 配置字段 `hashlineEdit`（去 `pi-` 前缀转 camelCase）。
 *
 * @module pi-hashline-edit/pi
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HashlineEditConfig {
	/** 是否启用 hashline（false 时透传内置 read/edit）。 */
	enabled: boolean;
	/** 行 hash 长度（默认 4）。 */
	hashLen: number;
}

const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, hashLen: 4 };

function getAgentDir(): string {
	const envDir = process.env.PI_AGENT_DIR;
	if (envDir) return envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** 直接 JSON.parse，不剥注释（标准 JSON 禁止注释，出错降级默认）。 */
function readSettings(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * 加载配置。项目 `cwd/.pi/settings.json` 的 `hashlineEdit` 整块替换全局，
 * 缺失字段由 DEFAULT_CONFIG 兜底。
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

/**
 * Session 级状态：文件快照存储（LRU）+ 配置。
 *
 * globalThis 单例（规避 Bun module identity 问题，见仓库 AGENTS）。
 * 快照 LRU 驱逐（默认 64 个文件），防长会话内存无限增长——冷文件被新文件挤出。
 * read 记录、edit 校验；key 为 canonical 绝对路径。
 * config 放 state，session_start 重载。
 *
 * @module pi-hashline-edit/pi
 */

import { createSnapshot } from "../core/snapshot.ts";
import type { FileSnapshot } from "../core/types.ts";
import type { HashlineEditConfig } from "./config.ts";

const GLOBAL_KEY = "__piHashlineEdit";
const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, hashLen: 4 };
/** 最多缓存的文件快照数；超出按 LRU 驱逐最久未访问的。 */
const MAX_SNAPSHOTS = 64;

export interface HashlineEditState {
	/** canonical path → 快照。LRU 顺序：Map 插入序，最近访问的在末尾。 */
	readonly snapshots: Map<string, FileSnapshot>;
	hashLen: number;
	config: HashlineEditConfig;
}

export function getState(): HashlineEditState {
	const g = globalThis as Record<string, unknown>;
	const existing = g[GLOBAL_KEY];
	if (existing) return existing as HashlineEditState;
	const state: HashlineEditState = {
		snapshots: new Map(),
		hashLen: DEFAULT_CONFIG.hashLen,
		config: DEFAULT_CONFIG,
	};
	g[GLOBAL_KEY] = state;
	return state;
}

/** 写入快照并维持 LRU：移到末尾（最近使用），超限驱逐最旧（Map 首项）。 */
function touchAndEvict(map: Map<string, FileSnapshot>, path: string, snap: FileSnapshot): void {
	if (map.has(path)) map.delete(path);
	map.set(path, snap);
	while (map.size > MAX_SNAPSHOTS) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/** 记录文件快照（read 时调用）：算行 hash + LRU。 */
export function recordSnapshot(canonicalPath: string, text: string): FileSnapshot {
	const state = getState();
	const snap = createSnapshot(canonicalPath, text, state.hashLen);
	touchAndEvict(state.snapshots, canonicalPath, snap);
	return snap;
}

/** 存入已算好的快照（edit 成功后更新），走 LRU。 */
export function putSnapshot(canonicalPath: string, snap: FileSnapshot): void {
	touchAndEvict(getState().snapshots, canonicalPath, snap);
}

/** 取文件快照（edit 校验用）；命中时移到末尾（LRU touch）。 */
export function getSnapshot(canonicalPath: string): FileSnapshot | undefined {
	const map = getState().snapshots;
	const snap = map.get(canonicalPath);
	if (snap) {
		map.delete(canonicalPath);
		map.set(canonicalPath, snap);
	}
	return snap;
}

/** 清空快照（session 重启时）。 */
export function clearSnapshots(): void {
	getState().snapshots.clear();
}

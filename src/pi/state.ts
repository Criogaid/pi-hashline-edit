/**
 * Session-level state: file snapshot store (LRU) + config.
 *
 * globalThis singleton (avoids Bun module-identity issues; see the repo AGENTS).
 * Snapshot LRU eviction (default 64 files) prevents unbounded memory growth in
 * long sessions — cold files are pushed out by new ones. read records; edit
 * verifies; key is the canonical absolute path.
 * config lives in state and is reloaded on session_start.
 *
 * @module pi-hashline-edit/pi
 */

import { createSnapshot } from "../core/snapshot.ts";
import type { FileSnapshot } from "../core/types.ts";
import type { HashlineEditConfig } from "./config.ts";

const GLOBAL_KEY = "__piHashlineEdit";
const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, hashLen: 4 };
/** Maximum number of cached file snapshots; beyond this the least-recently-accessed is evicted. */
const MAX_SNAPSHOTS = 64;

export interface HashlineEditState {
	/** canonical path → snapshot. LRU order: Map insertion order, most recently accessed at the end. */
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

/** Write a snapshot and maintain LRU: move to the end (most recently used); evict the oldest (Map's first entry) when over the limit. */
function touchAndEvict(map: Map<string, FileSnapshot>, path: string, snap: FileSnapshot): void {
	if (map.has(path)) map.delete(path);
	map.set(path, snap);
	while (map.size > MAX_SNAPSHOTS) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/** Record a file snapshot (called on read): compute line hashes + LRU bookkeeping. */
export function recordSnapshot(canonicalPath: string, text: string): FileSnapshot {
	const state = getState();
	const snap = createSnapshot(canonicalPath, text, state.hashLen);
	touchAndEvict(state.snapshots, canonicalPath, snap);
	return snap;
}

/** Store an already-computed snapshot (updated after a successful edit), via LRU. */
export function putSnapshot(canonicalPath: string, snap: FileSnapshot): void {
	touchAndEvict(getState().snapshots, canonicalPath, snap);
}

/** Get a file snapshot (for edit verification); on a hit move it to the end (LRU touch). */
export function getSnapshot(canonicalPath: string): FileSnapshot | undefined {
	const map = getState().snapshots;
	const snap = map.get(canonicalPath);
	if (snap) {
		map.delete(canonicalPath);
		map.set(canonicalPath, snap);
	}
	return snap;
}

/** Clear all snapshots (on session restart). */
export function clearSnapshots(): void {
	getState().snapshots.clear();
}

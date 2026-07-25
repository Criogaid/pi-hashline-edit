/**
 * Session-level config holder.
 *
 * globalThis singleton (consistent with the repo's module-identity guidance).
 * Config is loaded on session_start and read by the read/edit overrides.
 *
 * @module pi-hashline-edit/pi
 */

import type { HashlineEditConfig } from "./config.ts";

const GLOBAL_KEY = "__piHashlineEdit";
const DEFAULT_CONFIG: HashlineEditConfig = { enabled: true, hashLen: 4 };

export interface HashlineEditState {
	config: HashlineEditConfig;
}

export function getState(): HashlineEditState {
	const g = globalThis as Record<string, unknown>;
	const existing = g[GLOBAL_KEY];
	if (existing) return existing as HashlineEditState;
	const state: HashlineEditState = { config: DEFAULT_CONFIG };
	g[GLOBAL_KEY] = state;
	return state;
}

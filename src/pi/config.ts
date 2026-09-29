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
import { HASH_LEN_MAX, HASH_LEN_MIN } from "../core/hash.ts";
import { isIntegerInRange } from "./schema.ts";

export interface HashlineEditConfig {
  /** Master switch: when false the extension registers no tools — pi's built-ins remain. */
  enabled: boolean;
  /** Expose optional commands after edit/replace/write. Enabled by default; false disables them. */
  actionFusion: boolean;
  /** Line hash length. */
  hashLen: number;
  /** First-pass ±line radius before full-file recovery; 0 disables recovery. */
  shiftRadius: number;
}

const SHIFT_RADIUS_MAX = 100;

export const DEFAULT_CONFIG: HashlineEditConfig = {
  enabled: true,
  actionFusion: true,
  hashLen: 4,
  shiftRadius: 15,
};

/** Parse JSON directly without stripping comments (standard JSON forbids comments; on error fall back to default). */
function readSettings(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
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
  const raw =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    actionFusion:
      typeof raw.actionFusion === "boolean" ? raw.actionFusion : DEFAULT_CONFIG.actionFusion,
    hashLen: isIntegerInRange(raw.hashLen, HASH_LEN_MIN, HASH_LEN_MAX)
      ? raw.hashLen
      : DEFAULT_CONFIG.hashLen,
    shiftRadius: isIntegerInRange(raw.shiftRadius, 0, SHIFT_RADIUS_MAX)
      ? raw.shiftRadius
      : DEFAULT_CONFIG.shiftRadius,
  };
}

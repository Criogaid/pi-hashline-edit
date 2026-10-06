/**
 * Config loading: project `.pi/settings.json` replaces global, and each setting
 * that is missing or invalid falls back to its schema default. Config field
 * `hashlineEdit` (drop the `pi-` prefix, camelCase).
 *
 * @module pi-hashline-edit/pi
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { HASH_LEN_MAX, HASH_LEN_MIN } from "../core/hash.ts";
import { GREP_CONTEXT_RANGE, integerRange, POSITIVE_SAFE_INTEGER } from "./schema.ts";

function integerSetting(
  range: ReturnType<typeof integerRange>,
  value: number,
  description: string,
) {
  return Type.Number({ ...range, default: value, description });
}

/** Settings schema: the single source of setting types, bounds, and defaults. */
export const configSchema = Type.Object({
  enabled: Type.Boolean({
    default: true,
    description:
      "Master switch: when false the extension registers no tools; Pi's built-ins remain.",
  }),
  actionFusion: Type.Boolean({
    default: true,
    description: "Expose optional then_run commands after edit/replace/write.",
  }),
  forget: Type.Boolean({
    default: false,
    description: "Register forget and tag eligible read/grep results for context removal.",
  }),
  hashLen: integerSetting(
    integerRange(HASH_LEN_MIN, HASH_LEN_MAX),
    4,
    "Line hash length shared by every anchored tool.",
  ),
  shiftRadius: integerSetting(
    integerRange(0, 100),
    15,
    "First-pass ±line radius before full-file recovery; 0 disables recovery.",
  ),
  read: Type.Object({
    defaultLimit: integerSetting(
      POSITIVE_SAFE_INTEGER,
      500,
      "Lines returned when limit is omitted.",
    ),
    maxKiB: integerSetting(integerRange(1, 4096), 256, "Anchored text returned per call, in KiB."),
  }),
  grep: Type.Object({
    defaultLimit: integerSetting(
      POSITIVE_SAFE_INTEGER,
      100,
      "Matching lines returned when limit is omitted.",
    ),
    defaultContext: integerSetting(
      GREP_CONTEXT_RANGE,
      0,
      "Context lines shown when context is omitted.",
    ),
  }),
  replace: Type.Object({
    regexTimeoutMs: integerSetting(
      integerRange(1_000, 300_000),
      5_000,
      "Time limit for one regex batch, in milliseconds.",
    ),
  }),
});

export type HashlineEditConfig = Static<typeof configSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep each valid leaf; replace a missing or invalid leaf with its default. */
function resolveSetting<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (Type.IsObject(schema)) {
    const source = asRecord(value);
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, property]) => [
        key,
        resolveSetting(property, source[key]),
      ]),
    ) as Static<T>;
  }
  return (Value.Check(schema, value) ? value : Value.Create(schema)) as Static<T>;
}

export const DEFAULT_CONFIG: HashlineEditConfig = resolveSetting(configSchema, {});

/** Parse JSON directly without stripping comments (standard JSON forbids comments; on error fall back to default). */
function readSettings(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return asRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return {};
  }
}

/**
 * Load config. The `hashlineEdit` in project `cwd/.pi/settings.json` replaces
 * the global one wholesale; missing or invalid settings use their defaults.
 */
export function loadConfig(cwd?: string): HashlineEditConfig {
  const globalSettings = readSettings(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettings(path.join(cwd, ".pi", "settings.json")) : {};
  return resolveSetting(configSchema, projectSettings.hashlineEdit ?? globalSettings.hashlineEdit);
}

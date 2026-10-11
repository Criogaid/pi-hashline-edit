import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./path.ts";
import { COMMON_RG_ARGS, ripgrepFailure } from "./rg-process.ts";
import {
  recordSearchDiagnostics,
  scopeArgs,
  type GrepBackend,
  type SearchScope,
} from "./grep-search.ts";
import { throwIfCancelled } from "./error-text.ts";
import type { RgMatcher } from "./rg-regex.ts";
import { errnoCode, HashlineError } from "../core/errors.ts";

/**
 * Reject a translated matcher ripgrep cannot compile before any file is searched.
 * The arguments are ours, so a usage failure here is the pattern, such as an
 * unbounded PCRE2 lookbehind or a size limit.
 */
export async function assertValidRegex(
  matchers: readonly RgMatcher[],
  rgPath: string,
  backend: GrepBackend,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const matcher of matchers) {
    const result = await backend.probeRegex(rgPath, matcher, signal);
    throwIfCancelled(signal);
    if (result.code === 0 || result.code === 1) continue;
    if (result.code === 2)
      // ripgrep's error is the cause; it names the construct and position.
      throw new HashlineError("INVALID_REGEX", "ripgrep cannot compile the regex.", {
        cause: result.stderr.trim(),
      });
    throw ripgrepFailure("ripgrep could not check the regex.", result);
  }
}

/** Normalize a `string | string[]` param to an array (`undefined` → `[]`). */
export function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export interface SearchPathInfo {
  path: string;
  isFile: boolean;
}

export async function resolveSearchPaths(cwd: string, path: string | string[] | undefined) {
  const searchPaths = (() => {
    const values = toArray(path);
    return (values.length ? values : ["."]).map((value) => canonicalPath(cwd, value));
  })();
  const pathInfo: SearchPathInfo[] = [];
  for (const searchPath of searchPaths) {
    try {
      pathInfo.push({ path: searchPath, isFile: (await stat(searchPath)).isFile() });
    } catch (error) {
      // Only a missing path is PATH_NOT_FOUND; other filesystem errors keep their cause.
      if (errnoCode(error) !== "ENOENT") throw error;
      throw new HashlineError("PATH_NOT_FOUND", "Search path not found.", {
        facts: { missing: searchPath },
        ...(/[*?]/.test(searchPath) ? { next: "useGlob" as const } : {}),
      });
    }
  }
  return { searchPaths, pathInfo };
}

function fileKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function filterExplicitFilesByGlob(
  backend: GrepBackend,
  rgPath: string,
  scope: SearchScope,
  paths: readonly SearchPathInfo[],
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<string[]> {
  const explicitFiles = paths.filter(({ isFile }) => isFile);
  if (scope.globs.length === 0 || explicitFiles.length === 0) return paths.map(({ path }) => path);

  const parents = [...new Set(explicitFiles.map(({ path }) => dirname(path)))];
  const allowed = new Set<string>();
  // Direct file arguments bypass ignore and symlink traversal; let only the ordered globs decide admission.
  const args = [
    ...COMMON_RG_ARGS,
    ...scopeArgs({ ...scope, noIgnore: true, follow: true }),
    "--files",
    "--null",
    "--max-depth=1",
    "--",
    ...parents,
  ];
  const listed = await backend.runRgPaths(rgPath, args, signal, async (path) => {
    allowed.add(fileKey(path));
    return true;
  });
  recordSearchDiagnostics(listed, warnings);
  return paths
    .filter(({ path, isFile }) => !isFile || allowed.has(fileKey(path)))
    .map(({ path }) => path);
}

import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./path.ts";
import { COMMON_RG_ARGS } from "./rg-line-filter.ts";
import {
  recordSearchDiagnostics,
  scopeArgs,
  type GrepBackend,
  type SearchScope,
} from "./grep-search.ts";

export const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;

export async function resolveLiteralMode(
  patterns: readonly string[],
  explicit: boolean | undefined,
  multiline: boolean,
  rgPath: string,
  backend: GrepBackend,
  signal: AbortSignal | undefined,
  allowFallback: boolean,
): Promise<boolean> {
  if (explicit === true) return true;
  if (explicit === undefined && !patterns.some((pattern) => REGEX_SYNTAX.test(pattern)))
    return true;

  const result = await backend.runRg(
    rgPath,
    [
      ...COMMON_RG_ARGS,
      "--engine=default",
      multiline ? "--multiline" : "--no-multiline",
      "--quiet",
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "--",
      "-",
    ],
    signal,
    () => true,
  );
  if (signal?.aborted) throw new Error("Operation aborted");
  if (result.code === 0 || result.code === 1) return false;
  if (result.code === 2 && REGEX_PARSE_ERROR.test(result.stderr)) {
    if (explicit === false) throw new Error(result.stderr.trim());
    if (!allowFallback)
      throw new Error(
        `Invalid regex in compound query; automatic literal fallback is disabled. Fix the regex or set literal:true for all patterns.\n${result.stderr.trim()}`,
      );
    return true;
  }
  throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
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
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      const hint =
        missing && /[*?]/.test(searchPath)
          ? " Use an existing directory as path and a filename wildcard as glob."
          : "";
      throw new Error(`Path not found: ${searchPath}${hint}`);
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

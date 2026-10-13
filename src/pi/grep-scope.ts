/**
 * grep's search scope: path resolution, explicit-file admission under the caller's globs, and
 * the only conversion of a scope into rg flags.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./path.ts";
import { COMMON_RG_ARGS, recordSearchDiagnostics, type GrepBackend } from "./rg-process.ts";
import { errnoCode, HashlineError } from "../core/errors.ts";

export interface SearchScope {
  readonly globs: readonly string[];
  readonly noIgnore: boolean;
  readonly follow: boolean;
  readonly searchPaths: readonly string[];
}

/**
 * The only place scope becomes rg flags. Traversal that respects ignore rules also skips
 * `.git` directories, which `--hidden` would otherwise search; a named path is still searched.
 * The exclusion follows the caller's globs, because a later rg glob takes precedence.
 */
export function scopeArgs(scope: SearchScope): string[] {
  return [
    "--hidden",
    ...(scope.noIgnore ? ["--no-ignore"] : []),
    ...(scope.follow ? ["--follow"] : []),
    ...scope.globs.flatMap((glob) => ["--glob", glob]),
    ...(scope.noIgnore ? [] : ["--glob", "!.git"]),
  ];
}

/** Normalize a `string | string[]` param to an array (`undefined` → `[]`). */
export function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export interface SearchPathInfo {
  readonly path: string;
  readonly isFile: boolean;
}

/** Canonical search paths, the working directory when none is given; a missing one fails. */
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

/** Groups spellings that a case-insensitive filesystem may treat as one file. */
const foldedKey = (path: string): string => resolve(path).toLowerCase();

/** Whether rg listed the named file, possibly under its on-disk case spelling. */
async function isListed(path: string, listed: ReadonlyMap<string, readonly string[]>) {
  const spellings = listed.get(foldedKey(path)) ?? [];
  const absolute = resolve(path);
  if (spellings.some((spelling) => resolve(spelling) === absolute)) return true;
  if (!spellings.length) return false;
  const identity = (spelling: string) =>
    stat(spelling, { bigint: true }).then(
      ({ dev, ino }) => `${dev}:${ino}`,
      () => undefined,
    );
  const named = await identity(path);
  for (const spelling of spellings)
    if (named !== undefined && (await identity(spelling)) === named) return true;
  return false;
}

/** Keep directories and the explicitly named files that the ordered globs admit. */
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
  const allowed = new Map<string, string[]>();
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
    const key = foldedKey(path);
    allowed.set(key, [...(allowed.get(key) ?? []), path]);
    return true;
  });
  const admitted = new Set<string>();
  for (const { path } of explicitFiles) if (await isListed(path, allowed)) admitted.add(path);
  // Listing diagnostics about sibling entries matter only when they may explain an exclusion.
  if (admitted.size < explicitFiles.length) recordSearchDiagnostics(listed, warnings);
  return paths.filter(({ path, isFile }) => !isFile || admitted.has(path)).map(({ path }) => path);
}

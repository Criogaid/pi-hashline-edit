/**
 * grep's search scope: path resolution, explicit-file admission under the caller's globs, and
 * the only conversion of a scope into rg flags.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./path.ts";
import { COMMON_RG_ARGS, runRgPaths, searchDiagnostic } from "./rg-process.ts";
import { errnoCode, HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import type { SearchWarning } from "./error-text.ts";

export interface SearchScope {
  readonly globs: readonly string[];
  readonly searchPaths: readonly string[];
}

const globArgs = (globs: readonly string[]) => globs.flatMap((glob) => ["--glob", glob]);

/**
 * The rg flags of a search. Traversal respects ignore rules and also skips `.git` directories,
 * which `--hidden` would otherwise search; a named path is still searched. The exclusion follows
 * the caller's globs, because a later rg glob takes precedence.
 */
export function scopeArgs(scope: SearchScope): string[] {
  return ["--hidden", ...globArgs(scope.globs), "--glob", "!.git"];
}

interface SearchPathInfo {
  readonly path: string;
  readonly isFile: boolean;
}

/** Canonical search paths, the working directory when none is given; any missing one fails, all reported. */
export async function resolveSearchPaths(cwd: string, path: readonly string[] | undefined) {
  const pathInfo: SearchPathInfo[] = [];
  const missing: string[] = [];
  for (const value of path ?? ["."]) {
    const searchPath = canonicalPath(cwd, value);
    try {
      pathInfo.push({ path: searchPath, isFile: (await stat(searchPath)).isFile() });
    } catch (error) {
      // Only a missing path is PATH_NOT_FOUND; other filesystem errors keep their cause.
      if (errnoCode(error) !== "ENOENT") throw error;
      missing.push(searchPath);
    }
  }
  if (missing.length)
    throw new HashlineError("PATH_NOT_FOUND", PATH_ERROR_MESSAGES.PATH_NOT_FOUND, {
      facts: { missing },
      ...(missing.some((path) => /[*?]/.test(path)) ? { next: "useGlob" as const } : {}),
    });
  return pathInfo;
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

/**
 * Keep directories and the explicitly named files that the ordered globs admit, with the
 * listing's diagnostic when it may explain an exclusion.
 */
export async function filterExplicitFilesByGlob(
  globs: readonly string[],
  paths: readonly SearchPathInfo[],
  signal: AbortSignal | undefined,
): Promise<{ readonly searchPaths: string[]; readonly warnings: readonly SearchWarning[] }> {
  const explicitFiles = paths.filter(({ isFile }) => isFile);
  if (globs.length === 0 || explicitFiles.length === 0)
    return { searchPaths: paths.map(({ path }) => path), warnings: [] };

  const parents = [...new Set(explicitFiles.map(({ path }) => dirname(path)))];
  const allowed = new Map<string, string[]>();
  // Direct file arguments bypass ignore and symlink traversal; let only the ordered globs decide admission.
  const args = [
    ...COMMON_RG_ARGS,
    "--hidden",
    "--no-ignore",
    "--follow",
    ...globArgs(globs),
    "--files",
    "--null",
    "--max-depth=1",
    "--",
    ...parents,
  ];
  const listed = await runRgPaths(args, signal, async (path) => {
    const key = foldedKey(path);
    allowed.set(key, [...(allowed.get(key) ?? []), path]);
    return true;
  });
  const admitted = new Set<string>();
  for (const { path } of explicitFiles) if (await isListed(path, allowed)) admitted.add(path);
  // Listing diagnostics about sibling entries matter only when they may explain an exclusion.
  const diagnostic = admitted.size < explicitFiles.length ? searchDiagnostic(listed) : undefined;
  return {
    searchPaths: paths
      .filter(({ path, isFile }) => !isFile || admitted.has(path))
      .map(({ path }) => path),
    warnings: diagnostic ? [diagnostic] : [],
  };
}

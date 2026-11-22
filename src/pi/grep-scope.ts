/**
 * grep's search scope: path resolution, explicit-file admission under the caller's globs, and
 * the only conversion of a scope into rg flags.
 *
 * @module pi-hashline-edit/pi
 */
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isGlobSpelling, type ResolvedArgumentPath } from "./path.ts";
import { COMMON_RG_ARGS, runRgPaths, searchDiagnostic } from "./rg-process.ts";
import { errnoCode, HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import type { SearchWarning } from "./error-text.ts";

export interface SearchScope {
  /** The workspace; relative globs resolve against it. */
  readonly cwd: string;
  readonly globs: readonly string[];
  readonly searchPaths: readonly string[];
}

const globArgs = (globs: readonly string[]) => globs.flatMap((glob) => ["--glob", glob]);

/** Relative roots let rg match workspace globs even when its cwd resolves through a link. */
function globRoots(cwd: string, paths: readonly string[]): string[] {
  return paths.map((path) => {
    const rel = relative(cwd, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return path;
    // On Windows, relative() can fold case. Keep any spelling that does not round-trip.
    if (resolve(cwd, rel) !== path) return path;
    // rg treats a bare hyphen as stdin even after --.
    if (rel === "-") return `.${sep}-`;
    return rel || ".";
  });
}

/**
 * The rg flags and roots of a search. Traversal respects ignore rules and skips `.git` directories,
 * which `--hidden` would otherwise search. A named path is still searched. The exclusion follows
 * the caller's globs, because a later rg glob takes precedence.
 */
export function scopeArgs(scope: SearchScope): string[] {
  const { cwd, globs, searchPaths } = scope;
  const roots = globs.length ? globRoots(cwd, searchPaths) : searchPaths;
  return ["--hidden", ...globArgs(globs), "--glob", "!.git", "--", ...roots];
}

interface SearchPathInfo {
  readonly path: string;
  readonly isFile: boolean;
}

/**
 * Admit resolved search paths and identify the missing ones. The
 * call fails when every path is missing, or when a missing path is a wildcard meant for glob.
 */
export async function resolveSearchPaths(paths: readonly ResolvedArgumentPath[]) {
  const pathInfo: SearchPathInfo[] = [];
  const missing: string[] = [];
  let wildcard = false;
  for (const { absolutePath: searchPath, spelling } of paths) {
    try {
      pathInfo.push({ path: searchPath, isFile: (await stat(searchPath)).isFile() });
    } catch (error) {
      // Only a missing path is PATH_NOT_FOUND; other filesystem errors keep their cause.
      if (errnoCode(error) !== "ENOENT") throw error;
      missing.push(searchPath);
      wildcard ||= isGlobSpelling(spelling);
    }
  }
  if (wildcard || (missing.length && pathInfo.length === 0))
    throw new HashlineError("PATH_NOT_FOUND", PATH_ERROR_MESSAGES.PATH_NOT_FOUND, {
      facts: { missing },
      ...(wildcard ? { next: "useGlob" as const } : {}),
    });
  return { paths: pathInfo, missing };
}

/**
 * Listed file spellings, grouped by the folded path that a case-insensitive filesystem may treat
 * as one file. A lookup finds the same file without folding distinct files together.
 */
export class ListedFiles {
  private readonly spellings = new Map<string, string[]>();

  private static key(path: string): string {
    return resolve(path).toLowerCase();
  }

  add(path: string): void {
    const key = ListedFiles.key(path);
    const spellings = this.spellings.get(key);
    if (spellings) spellings.push(path);
    else this.spellings.set(key, [path]);
  }

  async has(path: string): Promise<boolean> {
    const spellings = this.spellings.get(ListedFiles.key(path)) ?? [];
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
}

/**
 * Keep directories and the explicitly named files that the ordered globs admit, with the
 * listing's diagnostic when it may explain an exclusion.
 */
export async function filterExplicitFilesByGlob(
  cwd: string,
  globs: readonly string[],
  paths: readonly SearchPathInfo[],
  signal: AbortSignal,
): Promise<{ readonly searchPaths: string[]; readonly warnings: readonly SearchWarning[] }> {
  const explicitFiles = paths.filter(({ isFile }) => isFile);
  if (globs.length === 0 || explicitFiles.length === 0)
    return { searchPaths: paths.map(({ path }) => path), warnings: [] };

  const parents = [...new Set(explicitFiles.map(({ path }) => dirname(path)))];
  const allowed = new ListedFiles();
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
    ...globRoots(cwd, parents),
  ];
  const listed = await runRgPaths(args, cwd, signal, async (path) => {
    allowed.add(resolve(cwd, path));
    return true;
  });
  const admitted = new Set<string>();
  for (const { path } of explicitFiles) if (await allowed.has(path)) admitted.add(path);
  const searchPaths = paths
    .filter(({ path, isFile }) => !isFile || admitted.has(path))
    .map(({ path }) => path);
  // Listing diagnostics about sibling entries matter only when they may explain an exclusion.
  const diagnostic = searchPaths.length < paths.length ? searchDiagnostic(listed) : undefined;
  return {
    searchPaths,
    warnings: diagnostic ? [diagnostic] : [],
  };
}

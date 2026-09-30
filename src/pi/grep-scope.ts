import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./path.ts";
import { COMMON_RG_ARGS } from "./rg-process.ts";
import {
  recordSearchDiagnostics,
  scopeArgs,
  type GrepBackend,
  type SearchScope,
} from "./grep-search.ts";
import { throwIfCancelled } from "./error-text.ts";

const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;
/**
 * Lookaround and backreferences: valid in JavaScript/PCRE, rejected by ripgrep's default engine.
 * The construct must be unescaped: an even run of backslashes (escaped backslashes) may precede it.
 */
const NON_RUST_REGEX_SYNTAX = /(?:^|[^\\])(?:\\\\)*(?:\(\?<?[=!]|\\[1-9]|\\k<)/;

/** Explain a parse failure caused by another regex dialect's syntax, if the query contains any. */
function regexDialectHint(patterns: readonly string[]): string | undefined {
  return patterns.some((pattern) => NON_RUST_REGEX_SYNTAX.test(pattern))
    ? "ripgrep's Rust regex has no lookaround or backreferences; rewrite the pattern, or use replace for a JavaScript regex within one file"
    : undefined;
}

/** Reject a regex query ripgrep cannot parse before any file is searched. */
export async function assertValidRegex(
  patterns: readonly string[],
  multiline: boolean,
  rgPath: string,
  backend: GrepBackend,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await backend.probeRegex(rgPath, patterns, multiline, signal);
  throwIfCancelled(signal);
  if (result.code === 0 || result.code === 1) return;
  if (result.code === 2 && REGEX_PARSE_ERROR.test(result.stderr)) {
    const hint = regexDialectHint(patterns) ?? "set literal:true to search the text exactly";
    throw new Error(`${result.stderr.trim()}\n${hint}.`);
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

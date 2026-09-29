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
import { throwIfCancelled } from "./error-text.ts";

export const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;
const LITERAL_FALLBACK_NOTICE = "Invalid regex; searched the pattern as literal text";
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

/** Notice for an invalid single pattern that was searched literally. */
export function literalFallbackNotice(patterns: readonly string[]): string {
  const hint = regexDialectHint(patterns);
  return hint ? `${LITERAL_FALLBACK_NOTICE}; ${hint}` : LITERAL_FALLBACK_NOTICE;
}

function withDialectHint(message: string, patterns: readonly string[]): string {
  const hint = regexDialectHint(patterns);
  return hint ? `${message}\n${hint}.` : message;
}

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
  throwIfCancelled(signal);
  if (result.code === 0 || result.code === 1) return false;
  if (result.code === 2 && REGEX_PARSE_ERROR.test(result.stderr)) {
    if (explicit === false) throw new Error(withDialectHint(result.stderr.trim(), patterns));
    if (!allowFallback)
      throw new Error(
        withDialectHint(
          `Invalid regex in compound query; automatic literal fallback is disabled. Fix the regex or set literal:true for all patterns.\n${result.stderr.trim()}`,
          patterns,
        ),
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

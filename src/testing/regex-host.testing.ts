/**
 * Host V8 regex support. Pi supports Node 22.19.0, whose V8 rejects modifier groups
 * (`(?i:…)`) and duplicate named groups; grep validates patterns with the host engine, so
 * cases that need this syntax run only where the host compiles them.
 */
export function hostCompiles(pattern: string, flags = ""): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/** Skip reason for `test`/`t.test` options when the host cannot compile every pattern. */
export function unsupportedByHost(patterns: readonly string[], flags = ""): string | false {
  return patterns.every((pattern) => hostCompiles(pattern, flags))
    ? false
    : `host V8 ${process.version} cannot compile this regex syntax`;
}

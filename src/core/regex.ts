/** JavaScript regex construction on the shared LF view, used by both grep and replace. */
import { normalizeLineEndings } from "./lines.ts";

/** JavaScript regex source on the shared LF view; literal text matches exactly. */
export function regexSource(find: string, literal: boolean): string {
  const logical = normalizeLineEndings(find);
  return literal ? logical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : logical;
}

/**
 * Both matcher modes operate on the shared LF view. Replace's and grep's argument checks
 * compile their regexes with it before any file is read.
 */
export function buildRegex(find: string, literal: boolean, flagsRaw: string | undefined): RegExp {
  const set = new Set((flagsRaw ?? "").split(""));
  set.add("g");
  const flagStr = [...set].join("");
  // The engine's SyntaxError already names the pattern and flags it compiled.
  return new RegExp(regexSource(find, literal), flagStr);
}

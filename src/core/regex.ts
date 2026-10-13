/** JavaScript regex construction on the shared LF view, used by both grep and replace. */
import { normalizeLineEndings } from "./lines.ts";
import { escapeRegex } from "./text.ts";

/** JavaScript regex source on the shared LF view; literal text matches exactly. */
export function regexSource(find: string, isRegex: boolean): string {
  const logical = normalizeLineEndings(find);
  return isRegex ? logical : escapeRegex(logical);
}

/**
 * Both matcher modes operate on the shared LF view. Flag characters are validated by the tool
 * schema; replace's and grep's prepareArguments also compile regexes here before any file is read.
 */
export function buildRegex(find: string, isRegex: boolean, flagsRaw: string | undefined): RegExp {
  const set = new Set((flagsRaw ?? "").split(""));
  set.add("g");
  const flagStr = [...set].join("");
  // The engine's SyntaxError already names the pattern and flags it compiled.
  return new RegExp(regexSource(find, isRegex), flagStr);
}

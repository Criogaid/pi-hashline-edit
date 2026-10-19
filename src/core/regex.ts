/** JavaScript regex construction on the shared LF view, used by both grep and replace. */
import { errorMessage } from "./errors.ts";
import { normalizeLineEndings } from "./lines.ts";
import { escapeRegex } from "./text.ts";

/** JavaScript regex source on the shared LF view; literal text matches exactly. */
export function regexSource(find: string, isRegex: boolean): string {
  const logical = normalizeLineEndings(find);
  return isRegex ? logical : escapeRegex(logical);
}

/**
 * Both matcher modes operate on the shared LF view. Replace's and grep's prepareArguments
 * validate flags with regexFlagsError and compile regexes here before any file is read.
 */
export function buildRegex(find: string, isRegex: boolean, flagsRaw: string | undefined): RegExp {
  const set = new Set((flagsRaw ?? "").split(""));
  set.add("g");
  const flagStr = [...set].join("");
  // The engine's SyntaxError already names the pattern and flags it compiled.
  return new RegExp(regexSource(find, isRegex), flagStr);
}

/** V8 decides which flags are valid; returns its diagnostic for flags buildRegex would reject. */
export function regexFlagsError(flags: string | undefined): string | undefined {
  try {
    buildRegex("", false, flags);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

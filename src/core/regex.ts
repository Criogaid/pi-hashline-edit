/** JavaScript regex construction on the shared LF view, used by both grep and replace. */
import { errorMessage } from "./errors.ts";
import { normalizeLineEndings } from "./lines.ts";
import { escapeRegex } from "./text.ts";

/** JavaScript regex source on the shared LF view; literal text matches exactly. */
export function regexSource(find: string, literal: boolean): string {
  const logical = normalizeLineEndings(find);
  return literal ? escapeRegex(logical) : logical;
}

/**
 * Both matcher modes operate on the shared LF view. Replace's and grep's prepareArguments
 * validate flags and compile regexes through checkRegexArguments before any file is read.
 */
export function buildRegex(find: string, literal: boolean, flagsRaw: string | undefined): RegExp {
  const set = new Set((flagsRaw ?? "").split(""));
  set.add("g");
  const flagStr = [...set].join("");
  // The engine's SyntaxError already names the pattern and flags it compiled.
  return new RegExp(regexSource(find, literal), flagStr);
}

/**
 * Report V8's diagnostics for a rule's flags and, in regex mode, for each pattern that
 * buildRegex would reject. Invalid flags stop the check, since every pattern compiles with
 * them; values that are not non-empty strings are left to schema validation.
 */
export function checkRegexArguments(
  flagsField: string,
  flags: string | undefined,
  literal: boolean,
  patterns: readonly (readonly [field: string, value: unknown])[],
  report: (field: string, reason: string) => void,
): void {
  try {
    buildRegex("", true, flags);
  } catch (error) {
    report(flagsField, errorMessage(error));
    return;
  }
  if (literal) return;
  for (const [field, value] of patterns) {
    if (typeof value !== "string" || value === "") continue;
    try {
      buildRegex(value, false, flags);
    } catch (error) {
      report(field, errorMessage(error));
    }
  }
}

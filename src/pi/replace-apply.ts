import { escapeRegex } from "../core/text.ts";
import {
  createLfTextView,
  detectLineEnding,
  normalizeLineEndings,
  restoreLineEndings,
} from "../core/lines.ts";
import { findSortedRangeConflict } from "../core/ranges.ts";

export interface Replacement {
  find: string;
  replace: string;
  regex?: boolean;
  flags?: string;
}

/** Both matcher modes operate on the shared LF view. Flag characters are validated by the tool schema. */
function buildRegex(find: string, isRegex: boolean, flagsRaw: string | undefined): RegExp {
  const set = new Set((flagsRaw ?? "").split(""));
  set.add("g");
  const flagStr = [...set].join("");
  const logical = normalizeLineEndings(find);
  const source = isRegex ? logical : escapeRegex(logical);
  try {
    return new RegExp(source, flagStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid regex /${source}/${flagStr}: ${msg}`);
  }
}

/** Expand JS replacement tokens against the original match, including prefix/suffix context. */
function expandReplacement(template: string, match: RegExpMatchArray, source: string): string {
  // Without named captures, $<...> is ordinary text and may contain other $ tokens.
  const tokens =
    match.groups === undefined ? /\$(\$|&|`|'|\d{1,2})/g : /\$(\$|&|`|'|<[^>]*>|\d{1,2})/g;
  return template.replace(tokens, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match[0];
    if (key === "`") return source.slice(0, match.index);
    if (key === "'") return source.slice(match.index! + match[0].length);
    if (key.startsWith("<"))
      return match.groups === undefined ? token : (match.groups[key.slice(1, -1)] ?? "");
    const index = Number(key);
    if (index > 0 && index < match.length) return match[index] ?? "";
    // $12 falls back to capture 1 plus literal 2 when capture 12 does not exist.
    const first = Number(key[0]);
    if (key.length === 2 && first > 0 && first < match.length) return (match[first] ?? "") + key[1];
    return token;
  });
}

export function applyReplacements(
  source: string,
  rules: readonly Replacement[],
): { text: string; count: number } {
  const changes: { start: number; end: number; text: string; rule: number }[] = [];
  const view = createLfTextView(source);
  const fallbackEnding = detectLineEnding(source) === "crlf" ? "\r\n" : "\n";
  for (const [index, rule] of rules.entries()) {
    try {
      const regex = buildRegex(rule.find, rule.regex === true, rule.flags);
      let count = 0;
      const replacement = normalizeLineEndings(rule.replace);
      for (const match of view.text.matchAll(regex)) {
        count++;
        const start = view.sourceOffset(match.index!);
        const end = view.sourceOffset(match.index! + match[0].length);
        changes.push({
          start,
          end,
          rule: index,
          text: restoreLineEndings(
            rule.regex ? expandReplacement(replacement, match, view.text) : replacement,
            source.slice(start, end),
            fallbackEnding,
          ),
        });
      }
      if (count === 0)
        throw new Error(
          `no matches for ${rule.regex ? `/${rule.find}/` : JSON.stringify(rule.find)}. Verify the target text with read or grep; check case sensitivity or regex flags if applicable.`,
        );
    } catch (error) {
      throw new Error(`rule ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  changes.sort((a, b) => a.start - b.start || a.end - b.end);
  const conflict = findSortedRangeConflict(changes.map((change) => [change.start, change.end]));
  if (conflict !== undefined) {
    const previous = changes[conflict - 1];
    const current = changes[conflict];
    throw new Error(
      `rules ${previous.rule} and ${current.rule} overlap at offset ${current.start}; no replacements applied`,
    );
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    parts.push(source.slice(cursor, change.start), change.text);
    cursor = change.end;
  }
  parts.push(source.slice(cursor));
  return { text: parts.join(""), count: changes.length };
}

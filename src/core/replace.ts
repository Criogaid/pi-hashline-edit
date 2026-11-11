/**
 * Replacement engine: apply literal or regex rules (built by regex.ts) over the
 * shared LF view, expand JavaScript replacement tokens, reject rules that match
 * nothing or overlap, and map each change back to the original text with its
 * line endings restored.
 *
 * @module pi-hashline-edit/core
 */

import { buildRegex } from "./regex.ts";
import {
  createLfTextView,
  detectLineEnding,
  joinTextFragments,
  normalizeLineEndings,
  restoreLineEndings,
} from "./lines.ts";
import { findSortedRangeConflict } from "./ranges.ts";
import { HashlineError } from "./errors.ts";

import type { Replacement, ReplacementResult } from "./replace-schema.ts";

/** Expand JS replacement tokens against the original match, including prefix/suffix context. */
function expandReplacement(template: string, match: RegExpExecArray, source: string): string {
  // Without named captures, $<...> is ordinary text and may contain other $ tokens.
  const tokens =
    match.groups === undefined ? /\$(\$|&|`|'|\d{1,2})/g : /\$(\$|&|`|'|<[^>]*>|\d{1,2})/g;
  return template.replace(tokens, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match[0];
    if (key === "`") return source.slice(0, match.index);
    if (key === "'") return source.slice(match.index + match[0].length);
    if (key.startsWith("<")) return match.groups![key.slice(1, -1)] ?? "";
    const index = Number(key);
    if (index > 0 && index < match.length) return match[index] ?? "";
    // $12 falls back to capture 1 plus literal 2 when capture 12 does not exist.
    const first = Number(key[0]);
    if (key.length === 2 && first > 0 && first < match.length) return (match[first] ?? "") + key[1];
    return token;
  });
}

/** A rule's field in the tool's arguments, as argument issues name it. */
const ruleField = (index: number): string => `replacements[${index}]`;

export function applyReplacements(
  source: string,
  rules: readonly Replacement[],
): ReplacementResult {
  const changes: { start: number; end: number; text: string; rule: number }[] = [];
  const view = createLfTextView(source);
  const fallbackEnding = detectLineEnding(source) === "crlf" ? "\r\n" : "\n";
  const unmatched: string[] = [];
  for (const [index, rule] of rules.entries()) {
    const regex = buildRegex(rule.find, rule.literal, rule.flags);
    let count = 0;
    const replacement = normalizeLineEndings(rule.replace);
    for (const match of view.text.matchAll(regex)) {
      count++;
      const start = view.sourceOffset(match.index);
      const end = view.sourceOffset(match.index + match[0].length);
      changes.push({
        start,
        end,
        rule: index,
        text: restoreLineEndings(
          rule.literal ? replacement : expandReplacement(replacement, match, view.text),
          source.slice(start, end),
          fallbackEnding,
        ),
      });
    }
    if (count === 0) unmatched.push(ruleField(index));
  }
  if (unmatched.length)
    throw new HashlineError("NO_MATCH", "Rules match nothing in the file.", {
      facts: { unmatched },
    });
  changes.sort((a, b) => a.start - b.start || a.end - b.end);
  const conflict = findSortedRangeConflict(changes.map((change) => [change.start, change.end]));
  if (conflict !== undefined) {
    const previous = changes[conflict - 1];
    const current = changes[conflict];
    throw new HashlineError("OVERLAPPING_MATCHES", "Matches of two rules overlap.", {
      facts: {
        conflict: [previous.rule, current.rule].sort((a, b) => a - b).map(ruleField),
        line: source.slice(0, current.start).split("\n").length,
      },
    });
  }
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const parts: string[] = [bom];
  let cursor = bom.length;
  for (const change of changes) {
    // Keep the original header at byte zero; a copied leading BOM denotes that same header.
    const text =
      bom && change.start === 0 && change.end > 0 && change.text.startsWith(bom)
        ? change.text.slice(1)
        : change.text;
    parts.push(source.slice(cursor, Math.max(bom.length, change.start)), text);
    cursor = Math.max(bom.length, change.end);
  }
  parts.push(source.slice(cursor));
  return { text: joinTextFragments(parts), count: changes.length };
}

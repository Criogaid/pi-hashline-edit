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
  newLineSeparator,
  joinTextFragments,
  normalizeLineEndings,
  restoreLineEndings,
  type TextFragment,
} from "./lines.ts";
import { findSortedRangeConflict } from "./ranges.ts";
import { HashlineError } from "./errors.ts";

import type { Replacement, ReplacementResult } from "./replace-schema.ts";

/** Expand JS replacement tokens, reusing a leading copy of the header when the match consumes it. */
function expandReplacement(template: string, match: RegExpExecArray, regex: RegExp): string {
  const { index, input, groups } = match;
  const consumesHeader = index === 0 && match[0].startsWith("\uFEFF");
  // Without named captures, $<...> is ordinary text and may contain other $ tokens.
  const tokens = groups === undefined ? /\$(\$|&|`|'|\d{1,2})/g : /\$(\$|&|`|'|<[^>]*>|\d{1,2})/g;
  // Track where a copy of the header can still be the first output character.
  let leadingOffset = consumesHeader ? 0 : -1;
  return template.replace(tokens, (token, key: string, offset: number) => {
    if (key === "$") return "$";
    if (key === "&") return offset === leadingOffset ? match[0].slice(1) : match[0];

    let text: string;
    let capture: string | number | undefined;
    if (key === "`") text = input.slice(0, index);
    else if (key === "'") text = input.slice(index + match[0].length);
    else if (key.startsWith("<")) {
      capture = key.slice(1, -1);
      text = groups?.[capture] ?? "";
    } else {
      // Prefer the whole reference ($01 is capture 1), then try just its first digit.
      const digits = Number(key) < match.length ? key : key[0];
      capture = Number(digits);
      if (capture === 0 || capture >= match.length) return token;
      text = (match[capture] ?? "") + key.slice(digits.length);
    }

    if (offset !== leadingOffset) return text;
    if (text === "") {
      leadingOffset += token.length;
      return text;
    }
    if (capture === undefined || text[0] !== input[0]) return text;

    // Adding d to the same regex at offset zero yields this match with capture offsets.
    const indices = match.indices ?? new RegExp(regex, `${regex.flags}d`).exec(input)!.indices!;
    const span = typeof capture === "number" ? indices[capture] : indices.groups?.[capture];
    return span?.[0] === 0 ? text.slice(1) : text;
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
  const bom = source.startsWith("\uFEFF") ? source[0] : "";
  const fallbackEnding = newLineSeparator(source);
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
          rule.literal ? replacement : expandReplacement(replacement, match, regex),
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
  const parts: TextFragment[] = [[0, bom.length]];
  // The header is copied separately, even when a match consumes it.
  let cursor = bom.length;
  for (const change of changes) {
    parts.push([cursor, Math.max(bom.length, change.start)], change.text);
    cursor = Math.max(bom.length, change.end);
  }
  parts.push([cursor, source.length]);
  return { ...joinTextFragments(source, parts), count: changes.length };
}

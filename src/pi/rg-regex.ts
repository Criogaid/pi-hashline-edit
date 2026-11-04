/**
 * Line-candidate translation: each grep pattern becomes an rg pattern that matches, over a
 * physical line's original bytes, every line whose LF view the JavaScript pattern matches,
 * and possibly more. Native RegExp re-checks only those lines, so a construct is translated
 * exactly where its meaning is the same on both sides and otherwise widened: an assertion
 * may be dropped and an element may match more text, but nothing a match needs is removed.
 *
 * Original line bytes differ from the LF view in three ways, each widened here: a CRLF line
 * keeps its CR before the line feed, malformed UTF-8 is U+FFFD in the view, and without u a
 * consuming element can match half of a supplementary character.
 *
 * @module pi-hashline-edit/pi
 */

import type { AST } from "@eslint-community/regexpp";
import {
  MAX_SCALAR,
  normalize,
  subtract,
  intersect,
  contains,
  nativeCharacterRanges,
  foldRanges,
  type Ranges,
  acceptedClassStrings,
  type CharacterNode,
  surrogatePair,
} from "../core/character-set.ts";
import { analyzeQueryPattern } from "../core/search-analysis.ts";
import type { GrepQuery } from "../core/search.ts";
import { MAX_RG_PATTERN_UNITS } from "./rg-process.ts";

const LF = 0x0a;
const REPLACEMENT = 0xfffd;
const SURROGATES: Ranges = [[0xd800, 0xdfff]];
const SUPPLEMENTARY: Ranges = [[0x10000, MAX_SCALAR]];
/** Repetition counts above this become unbounded, keeping rg's compiled size small. */
const MAX_EXACT_REPEAT = 16;
/** Bound expanded class strings by total code points, counting an empty string as one. */
const MAX_EXPANDED_STRING_POINTS = 256;

/** The bytes a lossy decoder shows as U+FFFD: every byte of a malformed sequence is 0x80–0xFF. */
const MALFORMED = "(?-u:[\\x80-\\xff])+";
/** Any text within one line, malformed bytes included. */
const ANY_TEXT = "(?-u:[^\\n])*";
const NEVER = "[^\\x{0}-\\x{10ffff}]";
/** Characters after which, or before which, JavaScript's m-mode ^ and $ hold inside a line. */
const TERMINATORS = "[\\r\\x{2028}\\x{2029}]";

interface Context {
  readonly ignoreCase: boolean;
  /** The i flag, which modifier groups override. */
  readonly flagIgnoreCase: boolean;
  readonly flagDotAll: boolean;
  /** u or v: elements consume code points, not UTF-16 units. */
  readonly unicode: boolean;
  readonly unicodeSets: boolean;
  readonly multilineAnchors: boolean;
  /** Translating a group as the text a backreference repeats, away from where it matched. */
  readonly repeated: boolean;
}

/** Whether nothing consumed can precede or follow an element within its pattern's match. */
interface Position {
  readonly first: boolean;
  readonly last: boolean;
}
const INNER: Position = { first: false, last: false };

const intersects = (ranges: Ranges, other: Ranges) => intersect(ranges, other).length !== 0;

const folded = (ranges: Ranges, ctx: Context): Ranges =>
  ctx.ignoreCase ? foldRanges(ranges, ctx.unicode) : ranges;

const escape = (point: number) =>
  /^[0-9A-Za-z_]$/.test(String.fromCodePoint(point))
    ? String.fromCodePoint(point)
    : `\\x{${point.toString(16)}}`;

function classPattern(ranges: Ranges): string {
  if (ranges.length === 1 && ranges[0][0] === ranges[0][1]) return escape(ranges[0][0]);
  return `[${ranges.map(([low, high]) => (low === high ? escape(low) : `${escape(low)}-${escape(high)}`)).join("")}]`;
}

/**
 * One consuming element over the units or code points it can match. U+FFFD may be malformed
 * bytes. Without u, a surrogate may be half of a supplementary character: the element then
 * consumes the whole character or nothing, and its neighbour consumes the other half.
 */
function unit(ranges: Ranges, ctx: Context): string {
  const halves = !ctx.unicode && intersects(ranges, SURROGATES);
  let scalars = subtract(ranges, [[LF, LF], ...SURROGATES]);
  if (halves) scalars = normalize([...scalars, ...SUPPLEMENTARY]);
  const alternatives = [
    ...(scalars.length ? [classPattern(scalars)] : []),
    ...(contains(ranges, REPLACEMENT) ? [MALFORMED] : []),
  ];
  if (!alternatives.length) return NEVER;
  const body = alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join("|")})`;
  return halves ? `(?:${body})?` : body;
}

function nativeFlags(node: AST.Node, ctx: Context): string {
  let dotAll = ctx.flagDotAll;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "Group" || !parent.modifiers) continue;
    if (parent.modifiers.add.dotAll) {
      dotAll = true;
      break;
    }
    if (parent.modifiers.remove?.dotAll) {
      dotAll = false;
      break;
    }
  }
  return `${ignoreCaseAt(node, ctx) ? "i" : ""}${dotAll ? "s" : ""}${ctx.unicodeSets ? "v" : ctx.unicode ? "u" : ""}`;
}

function scalarRanges(node: CharacterNode, ctx: Context): Ranges {
  const ranges = nativeCharacterRanges(node.raw, nativeFlags(node, ctx));
  // Case comparison at a reference can widen its capture's original character set.
  return ctx.repeated && ctx.ignoreCase && !ignoreCaseAt(node, ctx) ? folded(ranges, ctx) : ranges;
}

const choice = (patterns: readonly string[]): string =>
  patterns.length === 0 ? NEVER : patterns.length === 1 ? patterns[0] : `(?:${patterns.join("|")})`;

/** Factor common prefixes without dropping an alternative or cutting a code point escape. */
function wordTree(words: readonly (readonly number[])[], ctx: Context): string {
  const branches = new Map<number, number[][]>();
  let empty = false;
  for (const word of words) {
    if (!word.length) {
      empty = true;
      continue;
    }
    const branch = branches.get(word[0]) ?? [];
    branch.push(word.slice(1));
    branches.set(word[0], branch);
  }
  const patterns = [...branches].map(
    ([point, tails]) => unit(folded([[point, point]], ctx), ctx) + wordTree(tails, ctx),
  );
  if (empty) patterns.push("");
  return choice(patterns);
}

function stringPattern(strings: readonly string[], ctx: Context): string {
  const words = [...new Set(strings)].map((text) => [...text].map((char) => char.codePointAt(0)!));
  const size = words.reduce((sum, word) => sum + Math.max(1, word.length), 0);
  return size <= MAX_EXPANDED_STRING_POINTS ? wordTree(words, ctx) : ANY_TEXT;
}

function characterPattern(node: CharacterNode, ctx: Context): string {
  const accepted = acceptedClassStrings(node, nativeFlags(node, ctx));
  if (!accepted) return ANY_TEXT;
  const ranges = scalarRanges(node, ctx);
  return choice([
    ...(ranges.length ? [unit(ranges, ctx)] : []),
    ...(accepted.length
      ? [stringPattern(accepted, { ...ctx, ignoreCase: ctx.ignoreCase || ignoreCaseAt(node, ctx) })]
      : []),
  ]);
}

function assertion(node: AST.Assertion, ctx: Context, position: Position): string {
  // Repeated text held its assertions where the group matched, not where it repeats.
  if (ctx.repeated) return "";
  switch (node.kind) {
    case "start":
      // A line's first byte starts its view; with m, ^ also follows a terminator inside the
      // line, which the match may consume only when nothing before ^ belongs to it.
      if (!ctx.multilineAnchors) return "^";
      return position.first ? `(?:^|${TERMINATORS})` : "";
    case "end":
      // A CRLF line keeps its CR before the line feed, which the match may consume only when
      // nothing after $ belongs to it; with m, $ also precedes a terminator inside the line.
      if (!position.last) return "";
      return ctx.multilineAnchors ? `(?:${TERMINATORS}|\\r?$)` : "\\r?$";
    case "word":
      // JavaScript and rg agree on ASCII word boundaries over valid text and malformed bytes.
      // With u and i, \b also sees U+017F and U+212A; without u, \B holds between the two
      // halves of a supplementary character, which rg consumes as one.
      if (ctx.ignoreCase && ctx.unicode) return "";
      if (node.negate) return ctx.unicode ? "(?-u:\\B)" : "";
      return "(?-u:\\b)";
    default:
      if (!node.negate && position.first && position.last)
        return alternatives(node.alternatives, ctx, INNER);
      // Lookarounds consume nothing; dropping one only widens the candidates.
      return "";
  }
}

function quantifier(node: AST.Quantifier, ctx: Context): string {
  if (node.max === 0) return "";
  const inner = element(node.element, ctx, INNER);
  if (!inner) return "";
  const group = `(?:${inner})`;
  if (node.max === Infinity) {
    if (node.min === 0) return `${group}*`;
    if (node.min === 1) return `${group}+`;
    return node.min <= MAX_EXACT_REPEAT ? `${group}{${node.min},}` : `${group}+`;
  }
  if (node.max <= MAX_EXACT_REPEAT) return `${group}{${node.min},${node.max}}`;
  return node.min === 0 ? `${group}*` : `${group}+`;
}

/** A modifier group's i and m; its s needs nothing, since every . already matches anything. */
function modified(node: AST.Group, ctx: Context): Context {
  const { add, remove } = node.modifiers ?? {};
  if (!add) return ctx;
  return {
    ...ctx,
    // A capture's modifiers cannot remove case variants allowed where its text is repeated.
    ignoreCase: add.ignoreCase || ((ctx.repeated || !remove?.ignoreCase) && ctx.ignoreCase),
    multilineAnchors: add.multiline || (!remove?.multiline && ctx.multilineAnchors),
  };
}

/** ignoreCase where a node appears: the innermost modifier group that sets it decides. */
function ignoreCaseAt(node: AST.Node, ctx: Context): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === "Group" && parent.modifiers) {
      if (parent.modifiers.add.ignoreCase) return true;
      if (parent.modifiers.remove?.ignoreCase) return false;
    }
  return ctx.flagIgnoreCase;
}

/**
 * Whether a group has always matched when its backreference is reached: the group executes
 * before the reference in one alternative, and nothing between the group and that alternative
 * can skip it (another alternative, a quantifier that allows zero, or a lookaround).
 */
function participates(group: AST.CapturingGroup, reference: AST.Backreference): boolean {
  const ancestors = new Set<AST.Node>();
  for (let node: AST.Node | null = group; node; node = node.parent) ancestors.add(node);
  let referenceChild: AST.Node = reference;
  let common: AST.Node | null = reference.parent;
  while (common && !ancestors.has(common)) {
    referenceChild = common;
    common = common.parent;
  }
  if (common?.type !== "Alternative") return false;
  let groupChild: AST.Node = group;
  for (let node: AST.Node = group.parent; node !== common; node = node.parent!) {
    const kept =
      node.type === "Alternative" ||
      ((node.type === "Group" || node.type === "CapturingGroup") &&
        node.alternatives.length === 1) ||
      (node.type === "Quantifier" && node.min >= 1);
    if (!kept) return false;
    groupChild = node;
  }
  const elements: readonly AST.Node[] = common.elements;
  let backward = false;
  // The nearest lookaround decides direction; a nested lookahead runs forward again.
  for (let node: AST.Node | null = common.parent; node; node = node.parent) {
    if (node.type !== "Assertion") continue;
    backward = node.kind === "lookbehind";
    break;
  }
  const groupPosition = elements.indexOf(groupChild);
  const referencePosition = elements.indexOf(referenceChild);
  return backward ? groupPosition > referencePosition : groupPosition < referencePosition;
}

/**
 * A backreference repeats text its group matched, compared caselessly where the reference
 * is: the group's pattern under the case rule of either place matches it. A group that may
 * not have matched leaves the reference empty.
 */
function backreference(node: AST.Backreference, ctx: Context): string {
  // A reference inside repeated text could repeat itself.
  if (ctx.repeated) return ANY_TEXT;
  const groups = node.ambiguous ? node.resolved : [node.resolved];
  const copies = groups.map((group) =>
    alternatives(
      group.alternatives,
      { ...ctx, ignoreCase: ctx.ignoreCase || ignoreCaseAt(group, ctx), repeated: true },
      INNER,
    ),
  );
  const text = copies.length === 1 ? copies[0] : `(?:${copies.join("|")})`;
  if (!text) return "";
  return !node.ambiguous && participates(node.resolved, node) ? text : `(?:${text})?`;
}

function element(node: AST.Element, ctx: Context, position: Position): string {
  switch (node.type) {
    case "Character":
      if (node.value === LF) return NEVER;
      return unit(folded([[node.value, node.value]], ctx), ctx);
    case "CharacterClass":
    case "ExpressionCharacterClass":
    case "CharacterSet":
      return characterPattern(node, ctx);
    case "Assertion":
      return assertion(node, ctx, position);
    case "Backreference":
      return backreference(node, ctx);
    case "Group":
      return alternatives(node.alternatives, modified(node, ctx), position);
    case "CapturingGroup":
      return alternatives(node.alternatives, ctx, position);
    case "Quantifier":
      return quantifier(node, ctx);
  }
}

function alternatives(nodes: readonly AST.Alternative[], ctx: Context, position: Position): string {
  return choice(
    nodes.map(({ elements }) => {
      let pattern = "";
      for (let index = 0; index < elements.length; index++) {
        const pair = ctx.unicode ? undefined : surrogatePair(elements[index], elements[index + 1]);
        if (pair !== undefined) {
          pattern += classPattern([[pair, pair]]);
          index++;
          continue;
        }
        pattern += element(elements[index], ctx, {
          first: position.first && index === 0,
          last: position.last && index === elements.length - 1,
        });
      }
      return pattern;
    }),
  );
}

/**
 * rg patterns, one per query pattern, whose matching lines include every line the query
 * matches without multiline; undefined when parsing or translation exceeds supported budgets.
 */
export function lineCandidatePatterns(query: GrepQuery): string[] | undefined {
  const ctx: Context = {
    ignoreCase: query.flags.includes("i"),
    flagIgnoreCase: query.flags.includes("i"),
    flagDotAll: query.flags.includes("s"),
    unicode: query.flags.includes("u") || query.flags.includes("v"),
    unicodeSets: query.flags.includes("v"),
    multilineAnchors: query.flags.includes("m"),
    repeated: false,
  };
  const patterns: string[] = [];
  for (const pattern of query.patterns) {
    const translated = analyzeQueryPattern(pattern, query.literal, query.flags, (parsed) =>
      alternatives(parsed.alternatives, ctx, { first: true, last: true }),
    );
    if (translated === undefined) return undefined;
    if (
      translated.length + patterns.reduce((sum, value) => sum + value.length, 0) >
      MAX_RG_PATTERN_UNITS
    )
      return undefined;
    // A sticky match starts where the line starts.
    patterns.push(query.flags.includes("y") ? `^(?:${translated})` : translated);
  }
  return patterns;
}

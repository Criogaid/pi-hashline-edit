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
import { caseVariants } from "../core/case-fold.ts";
import { parseQueryPattern } from "../core/search-analysis.ts";
import type { GrepQuery } from "../core/search.ts";

/** Sorted, disjoint, inclusive code point ranges. */
type Ranges = readonly (readonly [number, number])[];

const LF = 0x0a;
const REPLACEMENT = 0xfffd;
const MAX_UNIT = 0xffff;
const MAX_SCALAR = 0x10ffff;
const SURROGATES: Ranges = [[0xd800, 0xdfff]];
const SUPPLEMENTARY: Ranges = [[0x10000, MAX_SCALAR]];
const DIGIT: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
/** With u and i, \w also matches U+017F and U+212A, whose case folds are word characters. */
const UNICODE_CASELESS_WORD: Ranges = [...WORD, [0x17f, 0x17f], [0x212a, 0x212a]];
/** ECMAScript WhiteSpace and LineTerminator. */
const SPACE: Ranges = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
/** Repetition counts above this become unbounded, keeping rg's compiled size small. */
const MAX_EXACT_REPEAT = 16;
/** Case folding expands a positive set of at most this many characters; larger sets match anything. */
const MAX_FOLDED_CHARS = 256;

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

function normalize(ranges: Iterable<readonly [number, number]>): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function complement(ranges: Ranges, max: number): Ranges {
  const result: [number, number][] = [];
  let next = 0;
  for (const [low, high] of ranges) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= max) result.push([next, max]);
  return result;
}

function subtract(ranges: Ranges, removed: Ranges): Ranges {
  const max = Math.max(MAX_SCALAR, ...ranges.map(([, high]) => high));
  const kept = complement(normalize(removed), max);
  const result: [number, number][] = [];
  for (const [low, high] of ranges)
    for (const [keepLow, keepHigh] of kept) {
      const from = Math.max(low, keepLow);
      const to = Math.min(high, keepHigh);
      if (from <= to) result.push([from, to]);
    }
  return result;
}

const total = (ranges: Ranges) => ranges.reduce((sum, [low, high]) => sum + high - low + 1, 0);
const intersects = (ranges: Ranges, other: Ranges) =>
  total(subtract(ranges, other)) !== total(ranges);
const contains = (ranges: Ranges, point: number) =>
  ranges.some(([low, high]) => low <= point && point <= high);

/** Everything one element can consume: one code point with u, one UTF-16 unit without. */
const everything = (ctx: Context): Ranges => (ctx.unicode ? [[0, MAX_SCALAR]] : [[0, MAX_UNIT]]);

/** Close a positive set under JavaScript's ignoreCase, or widen it to everything. */
function folded(ranges: Ranges, ctx: Context): Ranges {
  if (!ctx.ignoreCase) return ranges;
  if (total(ranges) > MAX_FOLDED_CHARS) return everything(ctx);
  const points: (readonly [number, number])[] = [...ranges];
  for (const [low, high] of ranges)
    for (let point = low; point <= high; point++) {
      const variants = caseVariants(String.fromCodePoint(point), ctx.unicode);
      if (!variants) return everything(ctx);
      for (const variant of variants) {
        const code = variant.codePointAt(0)!;
        points.push([code, code]);
      }
    }
  return normalize(points);
}

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

/**
 * The set of d, s, w or a negation. Each is closed under ignoreCase: w lists U+017F and
 * U+212A exactly when u and i let them match, and case never maps a digit or space elsewhere.
 */
function escapeSet(node: AST.EscapeCharacterSet, ctx: Context): Ranges {
  const positive =
    node.kind === "digit"
      ? DIGIT
      : node.kind === "space"
        ? SPACE
        : ctx.ignoreCase && ctx.unicode
          ? UNICODE_CASELESS_WORD
          : WORD;
  return node.negate ? complement(positive, everything(ctx)[0][1]) : positive;
}

/** Whether a class element's set is known exactly, as a negated class requires. */
function exactElement(element: AST.CharacterClassElement, ctx: Context): boolean {
  if (element.type === "Character" || element.type === "CharacterClassRange") return true;
  // With u and i, \w and \W depend on case folding beyond the sets above.
  return (
    element.type === "CharacterSet" &&
    element.kind !== "property" &&
    !(element.kind === "word" && ctx.ignoreCase && ctx.unicode)
  );
}

function elementSet(element: AST.CharacterClassElement, ctx: Context): Ranges | undefined {
  switch (element.type) {
    case "Character":
      return [[element.value, element.value]];
    case "CharacterClassRange":
      return [[element.min.value, element.max.value]];
    case "CharacterSet":
      return element.kind === "property" ? undefined : escapeSet(element, ctx);
    default:
      return undefined;
  }
}

function characterClass(node: AST.CharacterClass, ctx: Context): string {
  if (node.negate) {
    // The complement of an exact set without case folding contains the folded complement.
    if (ctx.ignoreCase && ctx.unicodeSets) return unit(everything(ctx), ctx);
    if (!node.elements.every((element) => exactElement(element, ctx)))
      return unit(everything(ctx), ctx);
    const inside = normalize(node.elements.flatMap((element) => elementSet(element, ctx)!));
    return unit(complement(inside, everything(ctx)[0][1]), ctx);
  }
  const characters: Ranges[] = [];
  const escapes: Ranges[] = [];
  for (const element of node.elements) {
    const set = elementSet(element, ctx);
    // A v-mode class may contain strings of several characters.
    if (!set) return ctx.unicodeSets ? ANY_TEXT : unit(everything(ctx), ctx);
    (element.type === "CharacterSet" ? escapes : characters).push(set);
  }
  return unit(normalize([...folded(normalize(characters.flat()), ctx), ...escapes.flat()]), ctx);
}

function characterSet(node: AST.CharacterSet, ctx: Context): string {
  switch (node.kind) {
    case "any":
      return unit(everything(ctx), ctx);
    case "property":
      // v-mode properties of strings match several characters.
      return node.strings ? ANY_TEXT : unit(everything(ctx), ctx);
    default:
      return unit(escapeSet(node, ctx), ctx);
  }
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
    ignoreCase: add.ignoreCase || (!remove?.ignoreCase && ctx.ignoreCase),
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
 * Whether a group has always matched when its backreference is reached: the group precedes
 * the reference in one alternative, and nothing between the group and that alternative can
 * skip it (another alternative, a quantifier that allows zero, or a lookaround).
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
  return elements.indexOf(groupChild) < elements.indexOf(referenceChild);
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
      return characterClass(node, ctx);
    case "ExpressionCharacterClass":
      return node.negate ? unit(everything(ctx), ctx) : ANY_TEXT;
    case "CharacterSet":
      return characterSet(node, ctx);
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

/** Without u, a supplementary character in the source is two Character nodes. */
function supplementary(node: AST.Element, next: AST.Element | undefined): number | undefined {
  if (node.type !== "Character" || next?.type !== "Character") return undefined;
  const [high, low] = [node.value, next.value];
  if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) return undefined;
  return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
}

function alternatives(nodes: readonly AST.Alternative[], ctx: Context, position: Position): string {
  const translated = nodes.map(({ elements }) => {
    let pattern = "";
    for (let index = 0; index < elements.length; index++) {
      const pair = ctx.unicode ? undefined : supplementary(elements[index], elements[index + 1]);
      if (pair !== undefined) {
        // ignoreCase without u never folds a supplementary character.
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
  });
  return translated.length === 1 ? translated[0] : `(?:${translated.join("|")})`;
}

/**
 * rg patterns, one per query pattern, whose matching lines include every line the query
 * matches without multiline; undefined when regexpp cannot parse a pattern V8 accepted.
 */
export function lineCandidatePatterns(query: GrepQuery): string[] | undefined {
  const ctx: Context = {
    ignoreCase: query.flags.includes("i"),
    flagIgnoreCase: query.flags.includes("i"),
    unicode: query.flags.includes("u") || query.flags.includes("v"),
    unicodeSets: query.flags.includes("v"),
    multilineAnchors: query.flags.includes("m"),
    repeated: false,
  };
  const patterns: string[] = [];
  for (const pattern of query.patterns) {
    const parsed = parseQueryPattern(pattern, query.literal, query.flags);
    if (!parsed) return undefined;
    const translated = alternatives(parsed.alternatives, ctx, { first: true, last: true });
    // A sticky match starts where the line starts.
    patterns.push(query.flags.includes("y") ? `^(?:${translated})` : translated);
  }
  return patterns;
}

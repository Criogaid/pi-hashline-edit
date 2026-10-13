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

import { visitRegExpAST, type AST } from "@eslint-community/regexpp";
import {
  MAX_UNIT,
  MAX_SCALAR,
  normalize,
  complement,
  subtract,
  intersect,
  total,
  contains,
  nativeCharacterRanges,
  foldRanges,
  membership,
  type Ranges,
  classStrings,
  type CharacterNode,
  surrogatePair,
} from "../core/character-set.ts";
import { caseVariants } from "../core/case-fold.ts";
import { parseQueryPattern } from "../core/search-analysis.ts";
import type { GrepQuery } from "../core/search.ts";

const LF = 0x0a;
const REPLACEMENT = 0xfffd;
const SURROGATES: Ranges = [[0xd800, 0xdfff]];
const SUPPLEMENTARY: Ranges = [[0x10000, MAX_SCALAR]];
/** Repetition counts above this become unbounded, keeping rg's compiled size small. */
const MAX_EXACT_REPEAT = 16;
/** Bound expanded class strings by total code points, counting an empty string as one. */
const MAX_EXPANDED_STRING_POINTS = 256;
/** Bound emitted string alternatives; oversized sets retain necessary prefixes. */
const MAX_STRING_PATTERN_UNITS = 8192;
const MAX_STRING_PREFIX_POINTS = 16;
/** Leave room for rg's arguments and paths on hosts with small command-line limits. */
const MAX_LINE_PATTERN_UNITS = 24 * 1024;

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
  readonly bindings: ReadonlyMap<AST.CapturingGroup, string>;
}

/** Whether nothing consumed can precede or follow an element within its pattern's match. */
interface Position {
  readonly first: boolean;
  readonly last: boolean;
}
const INNER: Position = { first: false, last: false };

/** Bound assertion alternatives and correlated capture expansion. */
const MAX_ANALYSIS_BRANCHES = 16;
const MAX_FIXED_UNITS = 64;
interface FixedSequence {
  readonly positions: readonly Ranges[];
  readonly exact: boolean;
}
type Constraints = ReadonlyMap<AST.Element, readonly Ranges[]>;

function fixedAlternatives(
  nodes: readonly AST.Alternative[],
  ctx: Context,
): FixedSequence | undefined {
  const branches: FixedSequence[] = [];
  for (const node of nodes) {
    const positions: Ranges[] = [];
    let exact = true;
    for (const child of node.elements) {
      const fixed = fixedSequence(child, ctx);
      if (!fixed) return undefined;
      positions.push(...fixed.positions);
      exact &&= fixed.exact;
      if (positions.length > MAX_FIXED_UNITS) return undefined;
    }
    branches.push({ positions, exact });
  }
  if (!branches.every((branch) => branch.positions.length === branches[0].positions.length))
    return undefined;
  return {
    positions: branches[0].positions.map((_, index) =>
      normalize(branches.flatMap((branch) => branch.positions[index])),
    ),
    exact:
      branches.every((branch) => branch.exact) &&
      (branches.length === 1 || branches[0].positions.length <= 1),
  };
}

function fixedSequence(node: AST.Element, ctx: Context): FixedSequence | undefined {
  switch (node.type) {
    case "Character":
    case "CharacterClass":
    case "ExpressionCharacterClass":
    case "CharacterSet":
      if (classStrings(node)?.length !== 0) return undefined;
      return { positions: [scalarRanges(node, ctx)], exact: true };
    case "Assertion":
      return { positions: [], exact: false };
    case "Backreference":
      return undefined;
    case "Group":
      return fixedAlternatives(node.alternatives, modified(node, ctx));
    case "CapturingGroup": {
      const bound = ctx.bindings.get(node);
      if (bound !== undefined)
        return {
          positions: [...(ctx.unicode ? [...bound] : bound.split(""))].map((char) => [
            [char.codePointAt(0)!, char.codePointAt(0)!],
          ]),
          exact: true,
        };
      return fixedAlternatives(node.alternatives, ctx);
    }
    case "Quantifier": {
      if (node.max === 0) return { positions: [], exact: true };
      if (node.min !== node.max || node.max > MAX_FIXED_UNITS) return undefined;
      const inner = fixedSequence(node.element, ctx);
      if (!inner || inner.positions.length * node.max > MAX_FIXED_UNITS) return undefined;
      return {
        positions: Array.from({ length: node.max }, () => inner.positions).flat(),
        exact: inner.exact,
      };
    }
  }
}

interface Neighbour {
  readonly node: AST.Element;
  readonly index: number;
  readonly ranges: Ranges;
}
function neighbours(
  elements: readonly AST.Element[],
  from: number,
  direction: number,
  count: number,
  ctx: Context,
  plan: Constraints,
): Neighbour[] {
  const result: Neighbour[] = [];
  for (
    let index = from + direction;
    index >= 0 && index < elements.length && result.length < count;
    index += direction
  ) {
    const node = elements[index];
    const fixed = fixedSequence(node, ctx);
    if (!fixed) break;
    const positions = plan.get(node) ?? fixed.positions;
    for (
      let at = direction > 0 ? 0 : positions.length - 1;
      at >= 0 && at < positions.length && result.length < count;
      at += direction
    )
      result.push({ node, index: at, ranges: positions[at] });
  }
  return result;
}

function restrict(
  plan: Constraints,
  neighbour: Neighbour,
  allowed: Ranges,
  ctx: Context,
): Constraints {
  const result = new Map(plan);
  const positions = [
    ...(result.get(neighbour.node) ?? fixedSequence(neighbour.node, ctx)!.positions),
  ];
  positions[neighbour.index] = intersect(positions[neighbour.index], allowed);
  result.set(neighbour.node, positions);
  return result;
}

/** Apply only proved constraints; a negative test needs an exact forbidden set. */
function assertionPlans(elements: readonly AST.Element[], ctx: Context): readonly Constraints[] {
  let plans: readonly Constraints[] = [new Map()];
  if (ctx.repeated) return plans;
  for (const [index, node] of elements.entries()) {
    if (node.type !== "Assertion") continue;
    if (node.kind === "lookahead" || node.kind === "lookbehind") {
      const fixed = fixedAlternatives(node.alternatives, ctx);
      if (!fixed) continue;
      const direction = node.kind === "lookahead" ? 1 : -1;
      const asserted = direction > 0 ? fixed.positions : [...fixed.positions].reverse();
      if (node.negate && (!fixed.exact || plans.length * asserted.length > MAX_ANALYSIS_BRANCHES))
        continue;
      plans = plans.flatMap((plan) => {
        const adjacent = neighbours(elements, index, direction, asserted.length, ctx, plan);
        if (node.negate) {
          if (adjacent.length !== asserted.length) return [plan];
          return adjacent.map((item, at) =>
            restrict(plan, item, complement(asserted[at], everything(ctx)[0][1]), ctx),
          );
        }
        let constrained = plan;
        for (const [at, item] of adjacent.entries())
          constrained = restrict(constrained, item, asserted[at], ctx);
        return [constrained];
      });
    } else if (node.kind === "word") {
      const word = nativeCharacterRanges("\\w", nativeFlags(node, ctx));
      plans = plans.map((plan) => {
        const left = neighbours(elements, index, -1, 1, ctx, plan)[0];
        const right = neighbours(elements, index, 1, 1, ctx, plan)[0];
        if (!left || !right) return plan;
        for (const [known, other] of [
          [left, right],
          [right, left],
        ]) {
          const isWord = subtract(known.ranges, word).length === 0;
          const isNonWord = intersect(known.ranges, word).length === 0;
          if (isWord || isNonWord)
            plan = restrict(
              plan,
              other,
              isWord === node.negate ? word : complement(word, everything(ctx)[0][1]),
              ctx,
            );
        }
        return plan;
      });
    } else {
      const direction = node.kind === "start" ? -1 : 1;
      plans = plans.map((plan) => {
        const neighbour = neighbours(elements, index, direction, 1, ctx, plan)[0];
        if (!neighbour) return plan;
        const terminators = nativeCharacterRanges("[\\n\\r\\u2028\\u2029]", ctx.unicode ? "u" : "");
        return restrict(
          plan,
          neighbour,
          node.kind === "start" && !ctx.multilineAnchors ? [] : terminators,
          ctx,
        );
      });
    }
  }
  return plans;
}

const intersects = (ranges: Ranges, other: Ranges) => intersect(ranges, other).length !== 0;

/** Everything one element can consume: one code point with u, one UTF-16 unit without. */
const everything = (ctx: Context): Ranges => (ctx.unicode ? [[0, MAX_SCALAR]] : [[0, MAX_UNIT]]);

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
  if (size <= MAX_EXPANDED_STRING_POINTS) return wordTree(words, ctx);
  const shortest = words.reduce((length, word) => Math.min(length, word.length), Infinity);
  if (!shortest) return ANY_TEXT;
  // A suffix survives only where it cannot overlap the retained prefix.
  const suffix: number[] = [];
  for (
    let index = 1;
    index <= Math.min(MAX_STRING_PREFIX_POINTS, Math.floor(shortest / 2));
    index++
  ) {
    const point = words[0].at(-index)!;
    if (!words.every((word) => word.at(-index) === point)) break;
    suffix.unshift(point);
  }
  for (
    let length = Math.min(MAX_STRING_PREFIX_POINTS, shortest - suffix.length);
    length >= 1;
    length = Math.floor(length / 2)
  ) {
    const prefixes = words.map((word) => word.slice(0, length));
    const pattern = wordTree(prefixes, ctx) + ANY_TEXT + wordTree([suffix], ctx);
    if (pattern.length <= MAX_STRING_PATTERN_UNITS) return pattern;
  }
  return ANY_TEXT;
}

function characterPattern(node: CharacterNode, ctx: Context): string {
  const strings = classStrings(node);
  if (!strings) return ANY_TEXT;
  const ranges = scalarRanges(node, ctx);
  const accepts = membership(node.raw, nativeFlags(node, ctx));
  const accepted = strings.filter((value) => accepts.test(value));
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
  if (!node.ambiguous) {
    const bound = ctx.bindings.get(node.resolved);
    if (bound !== undefined) return literalWord(bound, ctx);
  }
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
      return ctx.bindings.has(node)
        ? literalWord(ctx.bindings.get(node)!, { ...ctx, ignoreCase: false })
        : alternatives(node.alternatives, ctx, position);
    case "Quantifier":
      return quantifier(node, ctx);
  }
}

function alternatives(nodes: readonly AST.Alternative[], ctx: Context, position: Position): string {
  return choice(
    nodes.flatMap(({ elements }) =>
      assertionPlans(elements, ctx).map((plan) => {
        let pattern = "";
        for (let index = 0; index < elements.length; index++) {
          const constrained = plan.get(elements[index]);
          if (constrained) {
            pattern += constrained.map((ranges) => unit(ranges, ctx)).join("");
            continue;
          }
          const pair =
            ctx.unicode || plan.has(elements[index + 1])
              ? undefined
              : surrogatePair(elements[index], elements[index + 1]);
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
    ),
  );
}

function literalWord(text: string, ctx: Context): string {
  return [...text]
    .map((char) => {
      const point = char.codePointAt(0)!;
      return !ctx.unicode && point > MAX_UNIT
        ? classPattern([[point, point]])
        : unit(folded([[point, point]], ctx), ctx);
    })
    .join("");
}

function joinWords(
  left: readonly string[],
  right: readonly string[],
): readonly string[] | undefined {
  if (left.length * right.length > MAX_ANALYSIS_BRANCHES) return undefined;
  const words = [...new Set(left.flatMap((a) => right.map((b) => a + b)))];
  return words.some((word) => word.length > MAX_FIXED_UNITS) ? undefined : words;
}

function finiteWords(node: AST.Element, ctx: Context): readonly string[] | undefined {
  if (node.type === "Assertion" || node.type === "Backreference") return undefined;
  if (node.type === "Group" || node.type === "CapturingGroup") {
    const result: string[] = [];
    for (const branch of node.alternatives) {
      let words: readonly string[] = [""];
      for (const child of branch.elements) {
        const part = finiteWords(child, ctx);
        const joined = part && joinWords(words, part);
        if (!joined) return undefined;
        words = joined;
      }
      result.push(...words);
      if (result.length > MAX_ANALYSIS_BRANCHES) return undefined;
    }
    return [...new Set(result)];
  }
  if (node.type === "Quantifier") {
    if (node.max > MAX_ANALYSIS_BRANCHES) return undefined;
    if (!node.max) return [""];
    const inner = finiteWords(node.element, ctx);
    if (!inner) return undefined;
    let words: readonly string[] = [""];
    const result: string[] = node.min === 0 ? [""] : [];
    for (let count = 1; count <= node.max; count++) {
      const joined = joinWords(words, inner);
      if (!joined) return undefined;
      words = joined;
      if (count >= node.min) result.push(...words);
      if (result.length > MAX_ANALYSIS_BRANCHES) return undefined;
    }
    return [...new Set(result)];
  }
  const ranges = scalarRanges(node, ctx);
  if (total(ranges) > MAX_ANALYSIS_BRANCHES) return undefined;
  const result: string[] = [];
  for (const [low, high] of ranges)
    for (let point = low; point <= high; point++) result.push(String.fromCodePoint(point));
  const strings = classStrings(node);
  if (!strings) return undefined;
  const accepts = membership(node.raw, nativeFlags(node, ctx));
  for (const value of strings) {
    if (!accepts.test(value)) continue;
    let words: readonly string[] = [""];
    for (const char of value) {
      const variants = ignoreCaseAt(node, ctx) ? caseVariants(char, ctx.unicode) : [char];
      const joined = joinWords(words, variants);
      if (!joined) return undefined;
      words = joined;
    }
    result.push(...words);
    if (result.length > MAX_ANALYSIS_BRANCHES) return undefined;
  }
  return [...new Set(result)];
}

/** Enumerate only captures whose value is stable at every reference. */
function bindingContexts(parsed: AST.Pattern, ctx: Context): readonly Context[] {
  let contexts = [ctx];
  visitRegExpAST(parsed, {
    onCapturingGroupEnter(group) {
      if (
        !group.references.length ||
        group.references.some((ref) => ref.ambiguous || !participates(group, ref))
      )
        return;
      for (let parent: AST.Node | null = group.parent; parent; parent = parent.parent)
        if (parent.type === "Assertion" || parent.type === "Quantifier") return;
      let nested = false;
      visitRegExpAST(group, {
        onCapturingGroupEnter(node) {
          if (node !== group) nested = true;
        },
      });
      if (nested) return;
      const words = finiteWords(group, ctx);
      if (!words?.length || words.length * contexts.length > MAX_ANALYSIS_BRANCHES) return;
      contexts = contexts.flatMap((context) =>
        words.map((word) => ({
          ...context,
          bindings: new Map([...context.bindings, [group, word]]),
        })),
      );
    },
  });
  return contexts;
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
    bindings: new Map(),
  };
  const patterns: string[] = [];
  for (const pattern of query.patterns) {
    const parsed = parseQueryPattern(pattern, query.literal, query.flags);
    if (!parsed) return undefined;
    const translated = choice(
      bindingContexts(parsed, ctx).map((context) =>
        alternatives(parsed.alternatives, context, { first: true, last: true }),
      ),
    );
    if (
      translated.length + patterns.reduce((sum, value) => sum + value.length, 0) >
      MAX_LINE_PATTERN_UNITS
    )
      return undefined;
    // A sticky match starts where the line starts.
    patterns.push(query.flags.includes("y") ? `^(?:${translated})` : translated);
  }
  return patterns;
}

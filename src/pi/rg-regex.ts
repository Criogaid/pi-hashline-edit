/**
 * Translate the verified JS subset to rg over original bytes with --crlf.
 * Character sets use JS non-Unicode case folding, assertions use LF-view
 * boundaries, and capture numbering stays local to each caller pattern.
 * grep-plan selects native JS when a construct cannot be translated here.
 * Zero-maximum quantifiers retain group numbers without matching constraints.
 *
 * @module pi-hashline-edit/pi
 */

import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";
import { regexSource } from "../core/replace.ts";
import type { GrepQuery } from "../core/search.ts";

export type RgEngine = "default" | "pcre2";

/** One ripgrep search: the translated pattern, the engine that runs it, and its line mode. */
export interface RgMatcher {
  readonly engine: RgEngine;
  readonly pattern: string;
  /** ripgrep's multiline mode; a line query uses it only to match a standalone CR. */
  readonly multiline: boolean;
}

/** A valid JavaScript pattern outside the verified rg translation subset. */
export class RegexTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexTranslationError";
  }
}

/** Sorted, disjoint, inclusive ranges. */
type Ranges = readonly (readonly [number, number])[];

const LF = 0x0a;
const CR = 0x0d;
const MAX_UNIT = 0xffff;
const MAX_SCALAR = 0x10ffff;
const DIGIT: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
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
const LINE_TERMINATORS: Ranges = [
  [LF, LF],
  [CR, CR],
  [0x2028, 0x2029],
];
const NEVER = "[^\\x{0}-\\x{10ffff}]";
const PCRE2_WORD = "[0-9A-Za-z_]";
/** Logical line boundaries on original bytes, excluding the middle of CRLF. */
const LINE_BREAKS = classBody(LINE_TERMINATORS);
const OUTSIDE_CRLF = "(?!(?<=\\r)\\n)";
/** ASCII word boundaries, as JavaScript defines \b without the u flag. */
const WORD_BOUNDARY = {
  default: "(?-u:\\b)",
  pcre2: `(?:(?<=${PCRE2_WORD})(?!${PCRE2_WORD})|(?<!${PCRE2_WORD})(?=${PCRE2_WORD}))`,
} as const;
/**
 * \B holds between two non-word characters, so it needs PCRE2 to exclude the middle
 * of CRLF; the default engine also sees the CR of a CRLF line in line mode.
 */
const NOT_WORD_BOUNDARY = `(?:(?<=${PCRE2_WORD})(?=${PCRE2_WORD})|(?<!${PCRE2_WORD})(?!${PCRE2_WORD}))${OUTSIDE_CRLF}`;
/**
 * ripgrep's line-mode PCRE2 search strips only a CRLF terminator, so an LF-terminated
 * line's subject keeps its LF; no match may start after it, outside the line.
 */
const INSIDE_LINE = "(?!(?<=\\n)\\z)";
const LINE_ANCHORS = [
  `(?<![^${LINE_BREAKS}])${OUTSIDE_CRLF}`,
  `(?![^${LINE_BREAKS}])${OUTSIDE_CRLF}`,
] as const;
/** A line-mode input excludes its LF/CRLF separator but retains standalone CR. */
const PHYSICAL_LINE_ANCHORS = ["(?<![^\\n])", `(?=\\r?\\n|\\z)${OUTSIDE_CRLF}`] as const;
/** A CR that is not part of CRLF: the default engine's ^ never follows the CR of CRLF. */
const STANDALONE_CR = { default: "\\r^", pcre2: "\\r(?!\\n)" } as const;

function normalize(ranges: (readonly [number, number])[]): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1];
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

function contains(ranges: Ranges, value: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (value < ranges[middle][0]) high = middle - 1;
    else if (value > ranges[middle][1]) low = middle + 1;
    else return true;
  }
  return false;
}

function without(ranges: Ranges, value: number): Ranges {
  return ranges.flatMap(([low, high]): (readonly [number, number])[] => {
    if (value < low || value > high) return [[low, high]];
    return [
      ...(low < value ? [[low, value - 1] as const] : []),
      ...(value < high ? [[value + 1, high] as const] : []),
    ];
  });
}

let caseGroups: readonly (readonly number[])[] | undefined;

/** Code units that ignoreCase treats as equal: ECMA-262 Canonicalize without the u flag. */
function equivalentCases(): readonly (readonly number[])[] {
  if (caseGroups) return caseGroups;
  const groups = new Map<number, number[]>();
  for (let unit = 0; unit <= MAX_UNIT; unit++) {
    const upper = String.fromCharCode(unit).toUpperCase();
    const canonical =
      upper.length === 1 && !(unit >= 128 && upper.charCodeAt(0) < 128)
        ? upper.charCodeAt(0)
        : unit;
    const group = groups.get(canonical);
    if (group) group.push(unit);
    else groups.set(canonical, [unit]);
  }
  caseGroups = [...groups.values()].filter((group) => group.length > 1);
  return caseGroups;
}

function foldCase(units: Ranges): Ranges {
  const added: [number, number][] = [];
  for (const group of equivalentCases())
    if (group.some((unit) => contains(units, unit)))
      for (const unit of group) added.push([unit, unit]);
  return added.length ? normalize([...units, ...added]) : units;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function surrogatePair(element: AST.Node, next: AST.Node | undefined): number | undefined {
  if (element.type !== "Character" || next?.type !== "Character") return undefined;
  if (!isHighSurrogate(element.value) || !isLowSurrogate(next.value)) return undefined;
  return (element.value - 0xd800) * 0x400 + (next.value - 0xdc00) + 0x10000;
}

function withoutSurrogates(ranges: Ranges): Ranges {
  return ranges.flatMap(([low, high]): (readonly [number, number])[] => [
    ...(low < 0xd800 ? [[low, Math.min(high, 0xd7ff)] as const] : []),
    ...(high > 0xdfff ? [[Math.max(low, 0xe000), high] as const] : []),
  ]);
}

/** UTF-16 unit sets are representable only when they cannot split a surrogate pair. */
function toScalars(units: Ranges, inert: boolean): Ranges {
  if (!inert && units.some(([low, high]) => low <= 0xdfff && high >= 0xd800))
    throw new RegexTranslationError(
      "This character set can match half of a UTF-16 surrogate pair; ripgrep matches whole characters.",
    );
  return withoutSurrogates(units);
}

function scalarComplement(scalars: Ranges): Ranges {
  return withoutSurrogates(complement(scalars, MAX_SCALAR));
}

function escapeScalar(point: number): string {
  return point < 0x80 && /[0-9A-Za-z_]/.test(String.fromCharCode(point))
    ? String.fromCharCode(point)
    : `\\x{${point.toString(16)}}`;
}

function classBody(ranges: Ranges): string {
  return ranges
    .map(([low, high]) =>
      low === high ? escapeScalar(low) : `${escapeScalar(low)}-${escapeScalar(high)}`,
    )
    .join("");
}

/** One atom for a scalar set, in its shorter positive or negated form. */
function classText(scalars: Ranges): string {
  if (scalars.length === 0) return NEVER;
  if (scalars.length === 1 && scalars[0][0] === scalars[0][1]) return escapeScalar(scalars[0][0]);
  const excluded = scalarComplement(scalars);
  return excluded.length > 0 && excluded.length < scalars.length
    ? `[^${classBody(excluded)}]`
    : `[${classBody(scalars)}]`;
}

interface Context {
  readonly engine: RgEngine;
  readonly multiline: boolean;
  readonly ignoreCase: boolean;
  /** JavaScript's s flag. */
  readonly dotAll: boolean;
  /** JavaScript's m flag; grep sets it, and only a modifier group clears it. */
  readonly lineAnchors: boolean;
  readonly groups: ReadonlyMap<AST.CapturingGroup, number>;
  /** Capturing groups whose text the current element becomes part of. */
  readonly capturing: readonly AST.CapturingGroup[];
  /** Inside a quantifier with a maximum of zero: emitted for group numbering, never matched. */
  readonly inert: boolean;
  readonly repeated: boolean;
  readonly backward: boolean;
  readonly scan: Scan;
}

/** What a capturing group's text can hold, as far as a backreference to it is concerned. */
interface Capture {
  /** A line break, which the LF view and the original bytes spell differently. */
  lineBreak: boolean;
  /** A non-ASCII character, which PCRE2 and JavaScript fold differently. */
  nonAscii: boolean;
  /** JS clears captures on repetition; PCRE2 can retain a previous iteration's value. */
  repeated: boolean;
  /** JS evaluates lookbehind captures from right to left. */
  backward: boolean;
}

interface Scan {
  /** Set when a line query matches a standalone CR, which needs ripgrep's multiline mode. */
  standaloneCr: boolean;
  readonly captures: Map<AST.CapturingGroup, Capture>;
  readonly backreferences: {
    readonly node: AST.Backreference;
    readonly ignoreCase: boolean;
    readonly backward: boolean;
  }[];
  /** Groups whose text includes a backreference's text: [enclosing group, referenced group]. */
  readonly nested: [AST.CapturingGroup, AST.CapturingGroup][];
}

function capture(ctx: Context, found: Partial<Pick<Capture, "lineBreak" | "nonAscii">>): void {
  if (ctx.inert) return;
  for (const group of ctx.capturing) {
    const known = ctx.scan.captures.get(group)!;
    known.lineBreak ||= found.lineBreak ?? false;
    known.nonAscii ||= found.nonAscii ?? false;
  }
}

const isNonAscii = (scalars: Ranges) => scalars.some(([, high]) => high > 0x7f);

/** Translated text; an atom takes a quantifier without a group. */
interface Emitted {
  readonly text: string;
  readonly atom: boolean;
}

const atom = (text: string): Emitted => ({ text, atom: true });

/**
 * Emit a scalar set. grep skips files containing NUL, so no set needs it, and
 * ripgrep rejects a literal NUL. On the LF view \n is CRLF or LF and \r is a
 * standalone CR, so multiline sets that hold them match those byte sequences.
 * Line-mode sets drop LF but retain standalone CR through a multiline scan.
 */
function emitSet(set: Ranges, ctx: Context): Emitted {
  const scalars = without(set, 0);
  const hasLf = contains(scalars, LF);
  const hasCr = contains(scalars, CR);
  if (!hasLf && !hasCr) {
    capture(ctx, { nonAscii: isNonAscii(scalars) });
    return atom(classText(scalars));
  }
  if (!ctx.multiline) {
    const rest = without(without(scalars, LF), CR);
    if (!hasCr && rest.length === 0) return atom(NEVER);
    capture(ctx, { lineBreak: hasCr, nonAscii: isNonAscii(rest) });
    if (!hasCr) return atom(classText(rest));
    ctx.scan.standaloneCr ||= !ctx.inert;
    const branches: string[] = [STANDALONE_CR[ctx.engine]];
    if (rest.length) branches.push(classText(rest));
    return atom(`(?:${branches.join("|")})`);
  }
  capture(ctx, { lineBreak: true, nonAscii: isNonAscii(scalars) });
  const branches: string[] = [];
  let rest = without(scalars, CR);
  if (hasLf) {
    branches.push("\\r\\n");
    // PCRE2 lookbehind could otherwise start a match at the LF of CRLF.
    if (ctx.engine === "pcre2") {
      rest = without(rest, LF);
      branches.push("(?<!\\r)\\n");
    }
  }
  if (hasCr) branches.push(STANDALONE_CR[ctx.engine]);
  if (rest.length) branches.push(classText(rest));
  return atom(`(?:${branches.join("|")})`);
}

function unitSet(units: Ranges, ctx: Context): Ranges {
  return toScalars(ctx.ignoreCase ? foldCase(units) : units, ctx.inert);
}

function escapeUnits(node: AST.CharacterSet, ctx: Context): Ranges {
  if (node.kind === "any")
    return ctx.dotAll ? [[0, MAX_UNIT]] : complement(LINE_TERMINATORS, MAX_UNIT);
  if (node.kind === "property")
    throw new Error("Unicode property escapes require the u flag, which grep does not use.");
  const base = node.kind === "digit" ? DIGIT : node.kind === "word" ? WORD : SPACE;
  return node.negate ? complement(base, MAX_UNIT) : base;
}

function classSet(node: AST.CharacterClass, ctx: Context): Ranges {
  const units: (readonly [number, number])[] = [];
  for (const element of node.elements) {
    if (element.type === "Character") units.push([element.value, element.value]);
    else if (element.type === "CharacterClassRange")
      units.push([element.min.value, element.max.value]);
    else if (element.type === "CharacterSet") units.push(...escapeUnits(element, ctx));
    else throw new Error(`Unexpected ${element.type} without the v flag.`);
  }
  const normalized = normalize(units);
  const folded = ctx.ignoreCase ? foldCase(normalized) : normalized;
  return toScalars(node.negate ? complement(folded, MAX_UNIT) : folded, ctx.inert);
}

function quantifierText({ min, max, greedy }: AST.Quantifier): string {
  const base =
    max === Infinity
      ? min === 0
        ? "*"
        : min === 1
          ? "+"
          : `{${min},}`
      : min === 0 && max === 1
        ? "?"
        : min === max
          ? `{${min}}`
          : `{${min},${max}}`;
  return greedy ? base : `${base}?`;
}

function withModifiers(ctx: Context, { add, remove }: AST.Modifiers): Context {
  const flag = (key: "ignoreCase" | "multiline" | "dotAll", current: boolean) =>
    add[key] ? true : remove?.[key] ? false : current;
  return {
    ...ctx,
    ignoreCase: flag("ignoreCase", ctx.ignoreCase),
    lineAnchors: flag("multiline", ctx.lineAnchors),
    dotAll: flag("dotAll", ctx.dotAll),
  };
}

function emitAssertion(node: AST.Assertion, ctx: Context): Emitted {
  switch (node.kind) {
    case "start":
    case "end": {
      const index = node.kind === "start" ? 0 : 1;
      if (ctx.lineAnchors) return atom(LINE_ANCHORS[index]);
      return atom(ctx.multiline ? (index === 0 ? "\\A" : "\\z") : PHYSICAL_LINE_ANCHORS[index]);
    }
    case "word":
      return atom(node.negate ? NOT_WORD_BOUNDARY : WORD_BOUNDARY[ctx.engine]);
    case "lookahead":
    case "lookbehind": {
      const marker = `${node.kind === "lookbehind" ? "<" : ""}${node.negate ? "!" : "="}`;
      // Text a lookaround matches is not part of the groups around it.
      const inner = { ...ctx, capturing: [], backward: ctx.backward || node.kind === "lookbehind" };
      return atom(`(?${marker}${emitAlternatives(node.alternatives, inner)})`);
    }
  }
}

const targetsOf = (node: AST.Backreference) =>
  Array.isArray(node.resolved) ? node.resolved : [node.resolved];

/**
 * JavaScript matches a backreference to a group that did not participate as empty
 * text. (?r) keeps PCRE2 from folding ASCII to non-ASCII characters such as the
 * Kelvin sign; checkBackreferences admits only ASCII captures under ignoreCase.
 */
function emitBackreference(node: AST.Backreference, ctx: Context): Emitted {
  const targets = targetsOf(node);
  if (!ctx.inert) {
    ctx.scan.backreferences.push({ node, ignoreCase: ctx.ignoreCase, backward: ctx.backward });
    for (const outer of ctx.capturing)
      for (const target of targets) ctx.scan.nested.push([outer, target]);
  }
  const text = targets
    .map((group) => ctx.groups.get(group)!)
    .reduceRight((otherwise, index) => `(?(${index})\\g{${index}}|${otherwise})`, "");
  return atom(ctx.ignoreCase ? `(?ir:${text})` : text);
}

/**
 * A backreference matches the captured bytes again. Those equal JavaScript's text on
 * the LF view only without line breaks, and fold as JavaScript does only in ASCII.
 */
function checkBackreferences(scan: Scan): void {
  const { captures } = scan;
  // A group holding a backreference holds what its referenced group can capture.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [outer, target] of scan.nested) {
      const into = captures.get(outer)!;
      const from = captures.get(target)!;
      if ((from.lineBreak && !into.lineBreak) || (from.nonAscii && !into.nonAscii)) {
        into.lineBreak ||= from.lineBreak;
        into.nonAscii ||= from.nonAscii;
        changed = true;
      }
    }
  }
  for (const { node, ignoreCase, backward } of scan.backreferences) {
    const targets = targetsOf(node).map((group) => captures.get(group)!);
    if (backward || targets.some((target) => target.backward))
      throw new RegexTranslationError(
        `${node.raw} depends on lookbehind captures, which JavaScript evaluates in reverse order.`,
      );
    if (targets.some((target) => target.repeated))
      throw new RegexTranslationError(
        `${node.raw} references a capture inside a repeated expression; JavaScript and ripgrep reset captures differently.`,
      );
    if (targets.some((target) => target.lineBreak))
      throw new RegexTranslationError(
        `${node.raw} references a group that can match a line break; ripgrep compares the original bytes, where a line break may be CRLF.`,
      );
    if (ignoreCase && targets.some((target) => target.nonAscii))
      throw new RegexTranslationError(
        `${node.raw} ignores case for a group that can match non-ASCII text; ripgrep folds non-ASCII case differently from JavaScript.`,
      );
  }
}

function emitElement(node: AST.Element, ctx: Context): Emitted {
  switch (node.type) {
    case "Character":
      return emitSet(unitSet([[node.value, node.value]], ctx), ctx);
    case "CharacterSet":
      return emitSet(unitSet(escapeUnits(node, ctx), ctx), ctx);
    case "CharacterClass":
      return emitSet(classSet(node, ctx), ctx);
    case "Group": {
      const inner = node.modifiers ? withModifiers(ctx, node.modifiers) : ctx;
      return atom(`(?:${emitAlternatives(node.alternatives, inner)})`);
    }
    case "CapturingGroup": {
      if (!ctx.inert) {
        const capture = ctx.scan.captures.get(node)!;
        capture.repeated = ctx.repeated;
        capture.backward = ctx.backward;
      }
      const inner = { ...ctx, capturing: [...ctx.capturing, node] };
      return atom(`(${emitAlternatives(node.alternatives, inner)})`);
    }
    case "Assertion":
      return emitAssertion(node, ctx);
    case "Backreference":
      return emitBackreference(node, ctx);
    case "Quantifier": {
      const inner = emitElement(node.element, {
        ...ctx,
        inert: ctx.inert || node.max === 0,
        repeated: ctx.repeated || node.max > 1,
      });
      const body = inner.atom ? inner.text : `(?:${inner.text})`;
      return { text: body + quantifierText(node), atom: false };
    }
    case "ExpressionCharacterClass":
      throw new Error("Class set expressions require the v flag, which grep does not use.");
  }
}

function emitAlternatives(alternatives: readonly AST.Alternative[], ctx: Context): string {
  return alternatives
    .map(({ elements }) => {
      const parts: string[] = [];
      for (let index = 0; index < elements.length; index++) {
        // A surrogate pair is one supplementary character; ignoreCase never folds it without u.
        const pair = surrogatePair(elements[index], elements[index + 1]);
        if (pair !== undefined) {
          capture(ctx, { nonAscii: true });
          parts.push(escapeScalar(pair));
          index++;
        } else parts.push(emitElement(elements[index], ctx).text);
      }
      return parts.join("");
    })
    .join("|");
}

function parse(pattern: string, literal: boolean): AST.Pattern {
  const source = regexSource(pattern, !literal);
  return new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, {
    unicode: false,
    unicodeSets: false,
  });
}

/** Parser limits must not reject syntax already accepted by V8 at the tool boundary. */
export function isTranslationLimit(error: unknown): boolean {
  return (
    error instanceof RegexTranslationError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  );
}

/** Infer case from decoded characters; use case-sensitive matching if analysis is unavailable. */
export function smartIgnoreCase(patterns: readonly string[], literal: boolean): boolean {
  return !patterns.some((pattern) => {
    try {
      let uppercase = false;
      visitRegExpAST(parse(pattern, literal), {
        onCharacterEnter({ value }) {
          const text = String.fromCharCode(value);
          uppercase ||= text !== text.toLowerCase();
        },
      });
      return uppercase;
    } catch (error) {
      if (isTranslationLimit(error)) return true;
      throw error;
    }
  });
}

/**
 * Translate a query into the ripgrep scans that search it. Patterns sharing a scan
 * become non-capturing alternatives, with capture numbers offset for backreferences
 * in later patterns. grep-plan handles translation limits by selecting JavaScript.
 */
export function translateQuery(query: GrepQuery): RgMatcher[] {
  if (/[^dgims]/.test(query.flags))
    throw new RegexTranslationError("These flags require JavaScript evaluation.");
  const parsed = query.patterns.map((pattern) => parse(pattern, query.literal));
  // rg reports non-overlapping spans, so overlapping multiline alternatives need separate scans.
  const scans = query.multiline ? parsed.map((pattern) => [pattern]) : [parsed];
  return scans.map((scan) => translateScan(scan, query));
}

function translateScan(parsed: readonly AST.Pattern[], query: GrepQuery): RgMatcher {
  let engine = "default" as RgEngine;
  const groups = new Map<AST.CapturingGroup, number>();
  for (const pattern of parsed)
    visitRegExpAST(pattern, {
      onAssertionEnter(node) {
        if (node.kind !== "word" || node.negate) engine = "pcre2";
      },
      onBackreferenceEnter() {
        engine = "pcre2";
      },
      onCapturingGroupEnter(node) {
        groups.set(node, groups.size + 1);
      },
    });
  const ctx: Context = {
    engine,
    multiline: query.multiline,
    ignoreCase: query.flags.includes("i"),
    dotAll: query.flags.includes("s"),
    lineAnchors: query.flags.includes("m"),
    groups,
    capturing: [],
    inert: false,
    repeated: false,
    backward: false,
    scan: {
      standaloneCr: false,
      captures: new Map(
        [...groups.keys()].map((group) => [
          group,
          { lineBreak: false, nonAscii: false, repeated: false, backward: false },
        ]),
      ),
      backreferences: [],
      nested: [],
    },
  };
  const translated = parsed.map((pattern) => emitAlternatives(pattern.alternatives, ctx));
  checkBackreferences(ctx.scan);
  const multiline = query.multiline || ctx.scan.standaloneCr;
  const pattern =
    translated.length === 1 ? translated[0] : translated.map((text) => `(?:${text})`).join("|");
  return {
    engine,
    multiline,
    pattern: engine === "pcre2" && !multiline ? `${INSIDE_LINE}(?:${pattern})` : pattern,
  };
}

/** Conservative zero-width check: rg's PCRE2 multiline scanner can omit empty matches. */
export function mayMatchEmpty(query: GrepQuery): boolean {
  const nullable = (node: AST.Element): boolean => {
    switch (node.type) {
      case "Assertion":
      case "Backreference":
        return true;
      case "Group":
      case "CapturingGroup":
        return node.alternatives.some(({ elements }) => elements.every(nullable));
      case "Quantifier":
        return node.min === 0 || nullable(node.element);
      default:
        return false;
    }
  };
  return query.patterns.some((pattern) =>
    parse(pattern, query.literal).alternatives.some(({ elements }) => elements.every(nullable)),
  );
}

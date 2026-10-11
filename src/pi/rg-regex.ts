/**
 * JavaScript regex → ripgrep translation. grep accepts the JavaScript syntax replace
 * uses (without the u flag, validated by V8) and matches it on each file's LF view
 * with the m flag; ripgrep searches the original bytes with --crlf. regexpp parses
 * the pattern, and this module emits an equivalent ripgrep pattern: JavaScript
 * character sets and ignoreCase folding as explicit classes, CRLF-aware line
 * breaks, and PCRE2 only when lookaround or backreferences need it.
 *
 * Ripgrep matches code points, so a surrogate pair is one character and a lone
 * surrogate is rejected. ^ and $ treat a standalone CR as a line boundary, as
 * JavaScript does. Without multiline, ripgrep strips CR and LF from every class,
 * so a class such as \s drops CR. A set holding nothing but CR and LF matches a
 * standalone CR through ripgrep's multiline mode instead; no line-mode set holds
 * LF, so no match leaves its line.
 *
 * @module pi-hashline-edit/pi
 */

import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";
import { regexSource } from "../core/replace.ts";

export type RgEngine = "default" | "pcre2";

/** One ripgrep search: the translated pattern, the engine that runs it, and its line mode. */
export interface RgMatcher {
  readonly engine: RgEngine;
  readonly pattern: string;
  /** ripgrep's multiline mode; a line query uses it only to match a standalone CR. */
  readonly multiline: boolean;
}

/** A grep query as the caller wrote it; patterns are alternatives. */
export interface GrepQuery {
  readonly patterns: readonly string[];
  readonly literal: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
}

/** A valid JavaScript regex grep cannot search; `fix` is the argument change that can. */
export class RegexTranslationError extends Error {
  readonly fix: string | undefined;
  constructor(message: string, fix?: string) {
    super(message);
    this.name = "RegexTranslationError";
    this.fix = fix;
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
/** ASCII word boundaries, as JavaScript defines \b without the u flag. */
const WORD_BOUNDARY = {
  default: ["(?-u:\\b)", "(?-u:\\B)"],
  pcre2: [
    `(?:(?<=${PCRE2_WORD})(?!${PCRE2_WORD})|(?<!${PCRE2_WORD})(?=${PCRE2_WORD}))`,
    `(?:(?<=${PCRE2_WORD})(?=${PCRE2_WORD})|(?<!${PCRE2_WORD})(?!${PCRE2_WORD}))`,
  ],
} as const;
/**
 * Line anchors on the original bytes. With --crlf, ripgrep's default engine never
 * places ^ or $ inside CRLF; PCRE2 does, so its anchors exclude that position.
 */
const LINE_ANCHORS = {
  default: ["^", "$"],
  pcre2: ["(?<![^\\n\\r])(?!(?<=\\r)\\n)", "(?![^\\n\\r])(?!(?<=\\r)\\n)"],
} as const;
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

/**
 * Code-unit set → scalar set. A set holding every surrogate (such as . or a negated
 * class) also holds every supplementary character; a partial one cannot be searched.
 */
function toScalars(units: Ranges, supplementary: readonly number[]): Ranges {
  let surrogates = 0;
  let lone: number | undefined;
  for (const [low, high] of units) {
    const from = Math.max(low, 0xd800);
    const to = Math.min(high, 0xdfff);
    if (from > to) continue;
    surrogates += to - from + 1;
    lone ??= from;
  }
  const scalars = [
    ...withoutSurrogates(units),
    ...supplementary.map((point) => [point, point] as const),
  ];
  if (surrogates === 0x800) scalars.push([0x10000, MAX_SCALAR]);
  else if (lone !== undefined)
    throw new RegexTranslationError(
      `\\u${lone.toString(16).toUpperCase()} is half of a surrogate pair; ripgrep matches whole characters.`,
      "Write whole characters, and group a supplementary character before quantifying it, as in (?:😀)+.",
    );
  return normalize(scalars);
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
  /** Set when a line query matches a standalone CR, which needs ripgrep's multiline mode. */
  readonly scan: { standaloneCr: boolean };
}

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
 * Lines hold no LF, and line mode drops CR from a class that has other members.
 */
function emitSet(set: Ranges, ctx: Context): Emitted {
  const scalars = without(set, 0);
  const hasLf = contains(scalars, LF);
  const hasCr = contains(scalars, CR);
  if (!hasLf && !hasCr) return atom(classText(scalars));
  if (!ctx.multiline) {
    const rest = without(without(scalars, LF), CR);
    if (rest.length) return atom(classText(rest));
    if (!hasCr)
      throw new RegexTranslationError(
        "Without multiline, each line is matched without its line break, so \\n matches nothing.",
        "Set multiline to true to match across lines.",
      );
    ctx.scan.standaloneCr = true;
    return atom(`(?:${STANDALONE_CR[ctx.engine]})`);
  }
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

function unitSet(units: Ranges, ctx: Context, supplementary: readonly number[] = []): Ranges {
  return toScalars(ctx.ignoreCase ? foldCase(units) : units, supplementary);
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
  const supplementary: number[] = [];
  const { elements } = node;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    const pair = surrogatePair(element, elements[index + 1]);
    if (pair !== undefined) {
      supplementary.push(pair);
      index++;
    } else if (element.type === "Character") units.push([element.value, element.value]);
    else if (element.type === "CharacterClassRange")
      units.push([element.min.value, element.max.value]);
    else if (element.type === "CharacterSet") units.push(...escapeUnits(element, ctx));
    else throw new Error(`Unexpected ${element.type} without the v flag.`);
  }
  const scalars = unitSet(normalize(units), ctx, supplementary);
  return node.negate ? scalarComplement(scalars) : scalars;
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
      const [start, end] = LINE_ANCHORS[ctx.engine];
      // Line mode searches one line, so its input boundaries are line boundaries.
      if (!ctx.multiline || ctx.lineAnchors) return atom(node.kind === "start" ? start : end);
      return atom(node.kind === "start" ? "\\A" : "\\z");
    }
    case "word":
      return atom(WORD_BOUNDARY[ctx.engine][node.negate ? 1 : 0]);
    case "lookahead":
    case "lookbehind": {
      const marker = `${node.kind === "lookbehind" ? "<" : ""}${node.negate ? "!" : "="}`;
      return atom(`(?${marker}${emitAlternatives(node.alternatives, ctx)})`);
    }
  }
}

/** JavaScript matches a backreference to a group that did not participate as empty text. */
function emitBackreference(node: AST.Backreference, ctx: Context): Emitted {
  const targets = Array.isArray(node.resolved) ? node.resolved : [node.resolved];
  const text = targets
    .map((group) => ctx.groups.get(group)!)
    .reduceRight((otherwise, index) => `(?(${index})\\g{${index}}|${otherwise})`, "");
  return atom(ctx.ignoreCase ? `(?i:${text})` : text);
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
    case "CapturingGroup":
      return atom(`(${emitAlternatives(node.alternatives, ctx)})`);
    case "Assertion":
      return emitAssertion(node, ctx);
    case "Backreference":
      return emitBackreference(node, ctx);
    case "Quantifier": {
      const inner = emitElement(node.element, ctx);
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

/** Smart case for the whole query: ignore case unless a pattern contains an uppercase letter. */
export function smartIgnoreCase(patterns: readonly string[], literal: boolean): boolean {
  return !patterns.some((pattern) => {
    let uppercase = false;
    visitRegExpAST(parse(pattern, literal), {
      onCharacterEnter({ value }) {
        const text = String.fromCharCode(value);
        uppercase ||= text !== text.toLowerCase();
      },
    });
    return uppercase;
  });
}

/**
 * Translate a query into the ripgrep scans that search it. Patterns sharing a scan
 * become non-capturing alternatives, with capture numbers offset for backreferences
 * in later patterns. Throws RegexTranslationError; grep's prepareArguments reports
 * it before execution.
 */
export function translateQuery(query: GrepQuery): RgMatcher[] {
  const parsed = query.patterns.map((pattern) => parse(pattern, query.literal));
  // rg reports non-overlapping spans, so overlapping multiline alternatives need separate scans.
  const scans = query.multiline ? parsed.map((pattern) => [pattern]) : [parsed];
  return scans.map((scan) => translateScan(scan, query));
}

function translateScan(parsed: readonly AST.Pattern[], query: GrepQuery): RgMatcher {
  let engine: RgEngine = "default";
  const groups = new Map<AST.CapturingGroup, number>();
  for (const pattern of parsed)
    visitRegExpAST(pattern, {
      onAssertionEnter(node) {
        if (node.kind === "lookahead" || node.kind === "lookbehind") engine = "pcre2";
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
    ignoreCase: query.ignoreCase,
    dotAll: false,
    lineAnchors: true,
    groups,
    scan: { standaloneCr: false },
  };
  const translated = parsed.map((pattern) => emitAlternatives(pattern.alternatives, ctx));
  return {
    engine,
    multiline: query.multiline || ctx.scan.standaloneCr,
    pattern:
      translated.length === 1 ? translated[0] : translated.map((text) => `(?:${text})`).join("|"),
  };
}

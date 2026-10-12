/**
 * Static analysis of grep queries: smart case, and the necessary literals of grep's
 * candidate-file prefilter. Every JavaScript match of the query, on the LF view of a
 * file without NUL, satisfies every returned clause by containing one of its literals; that text
 * appears unchanged in the file's original bytes. Native RegExp still decides every
 * match; an unknown construct only widens the candidate set, down to every file.
 *
 * @module pi-hashline-edit/core
 */

import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";
import { caseVariants } from "./case-fold.ts";
import {
  nativeCharacterRanges,
  classStrings,
  membership,
  total,
  type CharacterNode,
} from "./character-set.ts";
import { regexSource } from "./replace.ts";
import type { GrepQuery } from "./search.ts";

/** One literal position: the characters JavaScript may match there. */
export type LiteralChar = readonly string[];
export type Literal = readonly LiteralChar[];
export interface LiteralFilter {
  readonly kind: "literals";
  readonly literals: readonly Literal[];
}
export type Prefilter =
  | { readonly kind: "all" }
  | LiteralFilter
  | { readonly kind: "and"; readonly filters: readonly LiteralFilter[] };

const ALL: Prefilter = { kind: "all" };
const MAX_SEQUENCES = 16;
const MAX_SEQUENCE_LENGTH = 64;
const MAX_CLASS_CHARS = 64;
const MAX_LITERALS = 64;
/** Dropping an AND clause widens safely; no OR alternative may be discarded. */
const MAX_PREFILTER_CLAUSES = 8;

/** Text of unknown length and content: a literal never spans it. */
const GAP = null;
type Unit = LiteralChar | typeof GAP;
type Sequence = readonly Unit[];

/** A node's bounded exact texts and necessary AND/OR conditions on original bytes. */
interface Info {
  readonly exact?: readonly Sequence[];
  readonly filter: Prefilter;
}

const EMPTY: Info = { exact: [[]], filter: ALL };
const UNKNOWN: Info = { exact: [[GAP]], filter: ALL };

interface Context {
  readonly ignoreCase: boolean;
  readonly unicode: boolean;
  readonly unicodeSets: boolean;
}

/**
 * Characters whose original bytes may differ from the LF view: LF stands for CRLF,
 * U+FFFD for malformed bytes, and a lone surrogate for half of a UTF-8 character.
 * Files containing NUL are never searched.
 */
function isUnstable(point: number): boolean {
  return point === 0 || point === 0x0a || point === 0xfffd || (point >= 0xd800 && point <= 0xdfff);
}

function charUnit(point: number, ctx: Context): Unit {
  if (isUnstable(point)) return GAP;
  const char = String.fromCodePoint(point);
  return ctx.ignoreCase ? caseVariants(char, ctx.unicode) : [char];
}

function unionUnits(units: readonly Unit[]): Unit {
  const chars = new Set<string>();
  for (const unit of units) {
    if (unit === GAP) return GAP;
    for (const char of unit) chars.add(char);
  }
  return chars.size > MAX_CLASS_CHARS ? GAP : [...chars].sort();
}

const key = (value: unknown) => JSON.stringify(value);

function distinct<T>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function literalFilter(values: readonly Literal[]): Prefilter {
  let literals = distinct(values);
  if (!literals.length || literals.some((literal) => !literal.length)) return ALL;
  if (literals.length <= MAX_LITERALS) return { kind: "literals", literals };
  // Keep every branch while shortening its necessary prefix or suffix.
  for (let length = MAX_SEQUENCE_LENGTH; length >= 1; length = Math.floor(length / 2)) {
    const prefix = distinct(literals.map((literal) => literal.slice(0, length)));
    const suffix = distinct(literals.map((literal) => literal.slice(-length)));
    const shorter = prefix.length <= suffix.length ? prefix : suffix;
    if (shorter.length <= MAX_LITERALS) return { kind: "literals", literals: shorter };
  }
  const first = unionUnits(literals.map((literal) => literal[0]));
  return first === GAP ? ALL : { kind: "literals", literals: [[first]] };
}

function implies(left: LiteralFilter, right: LiteralFilter): boolean {
  return left.literals.every((long) =>
    right.literals.some((short) => {
      for (let offset = 0; offset <= long.length - short.length; offset++)
        if (
          short.every((chars, index) => long[offset + index].every((char) => chars.includes(char)))
        )
          return true;
      return false;
    }),
  );
}

function andFilters(filters: readonly Prefilter[]): Prefilter {
  const clauses = distinct(
    filters.flatMap((filter) =>
      filter.kind === "all" ? [] : filter.kind === "and" ? filter.filters : [filter],
    ),
  );
  const kept = clauses.filter(
    (clause, index) =>
      !clauses.some(
        (other, at) =>
          at !== index && implies(other, clause) && (!implies(clause, other) || at < index),
      ),
  );
  kept.sort(
    (a, b) =>
      Math.min(...b.literals.map((literal) => literal.length)) -
        Math.min(...a.literals.map((literal) => literal.length)) ||
      a.literals.length - b.literals.length,
  );
  const bounded = kept.slice(0, MAX_PREFILTER_CLAUSES);
  return bounded.length === 0
    ? ALL
    : bounded.length === 1
      ? bounded[0]
      : { kind: "and", filters: bounded };
}

function orFilters(filters: readonly Prefilter[]): Prefilter {
  if (!filters.length || filters.some((filter) => filter.kind === "all")) return ALL;
  let result = filters[0];
  for (const filter of filters.slice(1)) {
    if (result.kind === "all" || filter.kind === "all") return ALL;
    const left = result.kind === "and" ? result.filters : [result];
    const right = filter.kind === "and" ? filter.filters : [filter];
    // CNF distribution creates AND clauses; keeping only bounded clauses is a widening.
    result = andFilters(
      left.flatMap((a) => right.map((b) => literalFilter([...a.literals, ...b.literals]))),
    );
  }
  return result;
}

function sequenceFilter(sequences: readonly Sequence[]): Prefilter {
  return orFilters(
    sequences.map((sequence) => {
      const filters: Prefilter[] = [];
      let run: LiteralChar[] = [];
      for (const unit of [...sequence, GAP]) {
        if (unit !== GAP) run.push(unit);
        else if (run.length) {
          filters.push(literalFilter([run]));
          run = [];
        }
      }
      return andFilters(filters);
    }),
  );
}

const filterOf = (info: Info): Prefilter =>
  info.exact ? andFilters([info.filter, sequenceFilter(info.exact)]) : info.filter;

function cross(left: readonly Sequence[], right: readonly Sequence[]): Sequence[] | undefined {
  if (left.length * right.length > MAX_SEQUENCES) return undefined;
  const result: Sequence[] = [];
  for (const a of left)
    for (const b of right) {
      if (a.length + b.length > MAX_SEQUENCE_LENGTH) return undefined;
      result.push([...a, ...b]);
    }
  return distinct(result);
}

function concatenate(infos: readonly Info[]): Info {
  let run: readonly Sequence[] = [[]];
  let whole = true;
  const filters = infos.map((info) => info.filter);
  for (const info of infos) {
    const joined = info.exact && cross(run, info.exact);
    if (joined) {
      run = joined;
      continue;
    }
    whole = false;
    filters.push(sequenceFilter(run));
    run = info.exact ?? [[]];
  }
  return whole
    ? { exact: run, filter: andFilters(filters) }
    : { filter: andFilters([...filters, sequenceFilter(run)]) };
}

function alternate(infos: readonly Info[]): Info {
  if (infos.every((info) => info.exact)) {
    const exact = distinct(infos.flatMap((info) => info.exact!));
    if (exact.length <= MAX_SEQUENCES)
      return { exact, filter: orFilters(infos.map((info) => info.filter)) };
  }
  return { filter: orFilters(infos.map(filterOf)) };
}

function repeat(exact: readonly Sequence[], count: number): readonly Sequence[] | undefined {
  if (exact.every((sequence) => !sequence.length)) return [[]];
  if (count > MAX_SEQUENCE_LENGTH) return undefined;
  let result: readonly Sequence[] | undefined = [[]];
  for (let index = 0; index < count && result; index++) result = cross(result, exact);
  return result;
}

function quantified(node: AST.Quantifier, ctx: Context): Info {
  if (node.max === 0) return EMPTY;
  const inner = analyzeElement(node.element, ctx);
  if (inner.exact) {
    const head = repeat(inner.exact, node.min);
    if (node.min === node.max && head) return { exact: head, filter: inner.filter };
    if (node.min === 0 && node.max === 1) {
      const exact = distinct([[], ...inner.exact]);
      if (exact.length <= MAX_SEQUENCES) return { exact, filter: ALL };
    }
    // The repetitions beyond the minimum are text of unknown length.
    const exact = head && cross(head, UNKNOWN.exact!);
    if (exact) return { exact, filter: node.min ? inner.filter : ALL };
  }
  return node.min === 0 ? UNKNOWN : { filter: filterOf(inner) };
}

function classInfo(node: CharacterNode, ctx: Context): Info {
  if (node.type === "CharacterSet" && node.kind === "any") return UNKNOWN;
  const strings = classStrings(node);
  if (!strings) return UNKNOWN;
  const flags = `${ctx.ignoreCase ? "i" : ""}${ctx.unicodeSets ? "v" : ctx.unicode ? "u" : ""}`;
  const ranges = nativeCharacterRanges(node.raw, flags);
  if (total(ranges) > MAX_CLASS_CHARS) return UNKNOWN;
  const units: Unit[] = [];
  for (const [low, high] of ranges)
    for (let point = low; point <= high; point++)
      units.push(charUnit(point, { ...ctx, ignoreCase: false }));
  const infos: Info[] = units.length ? [{ exact: [[unionUnits(units)]], filter: ALL }] : [];
  const accepts = membership(node.raw, flags);
  for (const value of strings) {
    if (!accepts.test(value)) continue;
    const sequence = [...value].map((char) => charUnit(char.codePointAt(0)!, ctx));
    infos.push(
      sequence.length <= MAX_SEQUENCE_LENGTH
        ? { exact: [sequence], filter: ALL }
        : { filter: sequenceFilter([sequence]) },
    );
  }
  return alternate(infos);
}

function analyzeElement(node: AST.Element, ctx: Context): Info {
  switch (node.type) {
    case "Character":
      return { exact: [[charUnit(node.value, ctx)]], filter: ALL };
    case "CharacterClass":
    case "CharacterSet":
    case "ExpressionCharacterClass":
      return classInfo(node, ctx);
    // Assertions and lookarounds consume nothing; the match text is the rest.
    case "Assertion":
      return (node.kind === "lookahead" || node.kind === "lookbehind") && !node.negate
        ? { exact: [[]], filter: filterOf(analyzeAlternatives(node.alternatives, ctx)) }
        : EMPTY;
    case "Backreference":
      return UNKNOWN;
    case "Group": {
      const ignoreCase = node.modifiers?.add.ignoreCase
        ? true
        : node.modifiers?.remove?.ignoreCase
          ? false
          : ctx.ignoreCase;
      return analyzeAlternatives(node.alternatives, { ...ctx, ignoreCase });
    }
    case "CapturingGroup":
      return analyzeAlternatives(node.alternatives, ctx);
    case "Quantifier":
      return quantified(node, ctx);
  }
}

/** Without u, a surrogate pair is two Character nodes that together match one character. */
function surrogatePair(element: AST.Element, next: AST.Element | undefined): number | undefined {
  if (element.type !== "Character" || next?.type !== "Character") return undefined;
  const [high, low] = [element.value, next.value];
  if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) return undefined;
  return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
}

function analyzeAlternatives(alternatives: readonly AST.Alternative[], ctx: Context): Info {
  return alternate(
    alternatives.map(({ elements }) => {
      const infos: Info[] = [];
      for (let index = 0; index < elements.length; index++) {
        const pair = ctx.unicode ? undefined : surrogatePair(elements[index], elements[index + 1]);
        if (pair === undefined) infos.push(analyzeElement(elements[index], ctx));
        else {
          infos.push({ exact: [[charUnit(pair, ctx)]], filter: ALL });
          index++;
        }
      }
      return concatenate(infos);
    }),
  );
}

/**
 * Parse a pattern V8 already accepted; undefined when regexpp lacks its syntax or
 * exceeds its own limits, which only makes an analysis less precise.
 */
export function parseQueryPattern(
  pattern: string,
  literal: boolean,
  flags: string,
): AST.Pattern | undefined {
  const source = regexSource(pattern, !literal);
  try {
    return new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, {
      unicode: flags.includes("u"),
      unicodeSets: flags.includes("v"),
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/** Smart case over decoded characters; case-sensitive when a pattern cannot be analyzed. */
export function smartIgnoreCase(
  patterns: readonly string[],
  literal: boolean,
  flags = "",
): boolean {
  return !patterns.some((pattern) => {
    const parsed = parseQueryPattern(pattern, literal, flags);
    if (!parsed) return true;
    let uppercase = false;
    visitRegExpAST(parsed, {
      onCharacterEnter({ value }) {
        const text = String.fromCodePoint(value);
        uppercase ||= text !== text.toLowerCase();
      },
    });
    return uppercase;
  });
}

/** Necessary file conditions in bounded conjunctive normal form; every OR retains all alternatives. */
export function extractPrefilter(query: GrepQuery): Prefilter {
  const unicode = query.flags.includes("u") || query.flags.includes("v");
  const ctx: Context = {
    ignoreCase: query.flags.includes("i"),
    unicode,
    unicodeSets: query.flags.includes("v"),
  };
  return orFilters(
    query.patterns.map((pattern) => {
      const parsed = parseQueryPattern(pattern, query.literal, query.flags);
      return parsed ? filterOf(analyzeAlternatives(parsed.alternatives, ctx)) : ALL;
    }),
  );
}

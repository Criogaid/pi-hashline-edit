/**
 * Necessary literals for grep's candidate-file prefilter. Every JavaScript match of
 * the query, on the LF view of a file without NUL, contains at least one returned
 * literal, and that literal's text appears unchanged in the file's original bytes.
 * Native RegExp still decides every match; an unknown construct only widens the
 * candidate set, down to every file.
 *
 * @module pi-hashline-edit/core
 */

import { RegExpParser, type AST } from "@eslint-community/regexpp";
import { caseVariants } from "./case-fold.ts";
import { regexSource } from "./replace.ts";
import type { GrepQuery } from "./search.ts";

/** One literal position: the characters JavaScript may match there. */
export type LiteralChar = readonly string[];
export type Literal = readonly LiteralChar[];
export type Prefilter =
  | { readonly kind: "all" }
  | { readonly kind: "literals"; readonly literals: readonly Literal[] };

const ALL: Prefilter = { kind: "all" };
const MAX_SEQUENCES = 16;
const MAX_SEQUENCE_LENGTH = 64;
const MAX_CLASS_CHARS = 64;
const MAX_LITERALS = 64;

/** Text of unknown length and content: a literal never spans it. */
const GAP = null;
type Unit = LiteralChar | typeof GAP;
type Sequence = readonly Unit[];

/** A node's finite set of exact texts, and literals one of which each match contains. */
interface Info {
  readonly exact?: readonly Sequence[];
  /** Undefined when no literal is known to be necessary. */
  readonly required?: readonly Literal[];
}

const EMPTY: Info = { exact: [[]] };
const UNKNOWN: Info = { exact: [[GAP]] };

interface Context {
  readonly ignoreCase: boolean;
  readonly unicode: boolean;
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
  return ctx.ignoreCase ? (caseVariants(char, ctx.unicode) ?? GAP) : [char];
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

/** The longest gap-free run of each sequence; undefined when one has none. */
function necessary(sequences: readonly Sequence[]): Literal[] | undefined {
  const literals: Literal[] = [];
  for (const sequence of sequences) {
    let best: LiteralChar[] = [];
    let run: LiteralChar[] = [];
    for (const unit of [...sequence, GAP]) {
      if (unit !== GAP) run.push(unit);
      else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (best.length === 0) return undefined;
    literals.push(best);
  }
  return distinct(literals);
}

const requiredOf = (info: Info) =>
  info.required ?? (info.exact ? necessary(info.exact) : undefined);

/** Prefer literals whose shortest member is longest, then fewer alternatives. */
function better(left: readonly Literal[] | undefined, right: readonly Literal[] | undefined) {
  if (!left) return right;
  if (!right) return left;
  const shortest = (literals: readonly Literal[]) =>
    Math.min(...literals.map((literal) => literal.length));
  const difference = shortest(right) - shortest(left);
  return difference > 0 || (difference === 0 && right.length < left.length) ? right : left;
}

function concatenate(infos: readonly Info[]): Info {
  let run: readonly Sequence[] = [[]];
  let whole = true;
  let required: readonly Literal[] | undefined;
  for (const info of infos) {
    const joined = info.exact && cross(run, info.exact);
    if (joined) {
      run = joined;
      continue;
    }
    whole = false;
    required = better(required, necessary(run));
    if (info.exact) run = info.exact;
    else {
      required = better(required, info.required);
      run = [[]];
    }
  }
  if (whole) return { exact: run };
  return { required: better(required, necessary(run)) };
}

function alternate(infos: readonly Info[]): Info {
  if (infos.every((info) => info.exact)) {
    const exact = distinct(infos.flatMap((info) => info.exact!));
    if (exact.length <= MAX_SEQUENCES) return { exact };
  }
  const literals: Literal[] = [];
  for (const info of infos) {
    const required = requiredOf(info);
    if (!required) return {};
    literals.push(...required);
  }
  const required = distinct(literals);
  return required.length <= MAX_LITERALS ? { required } : {};
}

function repeat(exact: readonly Sequence[], count: number): readonly Sequence[] | undefined {
  let result: readonly Sequence[] | undefined = [[]];
  for (let index = 0; index < count && result; index++) result = cross(result, exact);
  return result;
}

function quantified(node: AST.Quantifier, ctx: Context): Info {
  if (node.max === 0) return EMPTY;
  const inner = analyzeElement(node.element, ctx);
  if (inner.exact) {
    const head = repeat(inner.exact, node.min);
    if (node.min === node.max && head) return { exact: head };
    if (node.min === 0 && node.max === 1) {
      const exact = distinct([[], ...inner.exact]);
      if (exact.length <= MAX_SEQUENCES) return { exact };
    }
    // The repetitions beyond the minimum are text of unknown length.
    const exact = head && cross(head, UNKNOWN.exact!);
    if (exact) return { exact };
  }
  return node.min === 0 ? UNKNOWN : { required: requiredOf(inner) };
}

function classUnit(node: AST.CharacterClass, ctx: Context): Unit {
  if (node.negate) return GAP;
  const units: Unit[] = [];
  for (const element of node.elements) {
    if (element.type === "Character") units.push(charUnit(element.value, ctx));
    else if (
      element.type === "CharacterClassRange" &&
      element.max.value - element.min.value < MAX_CLASS_CHARS
    )
      for (let point = element.min.value; point <= element.max.value; point++)
        units.push(charUnit(point, ctx));
    else return GAP;
  }
  return units.length ? unionUnits(units) : GAP;
}

function analyzeElement(node: AST.Element, ctx: Context): Info {
  switch (node.type) {
    case "Character":
      return { exact: [[charUnit(node.value, ctx)]] };
    case "CharacterClass":
      return { exact: [[classUnit(node, ctx)]] };
    case "CharacterSet":
    case "ExpressionCharacterClass":
      return UNKNOWN;
    // Assertions and lookarounds consume nothing; the match text is the rest.
    case "Assertion":
      return EMPTY;
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
          infos.push({ exact: [[charUnit(pair, ctx)]] });
          index++;
        }
      }
      return concatenate(infos);
    }),
  );
}

/** Literals one of which every match of the query contains, or every file when unknown. */
export function extractPrefilter(query: GrepQuery): Prefilter {
  const unicode = query.flags.includes("u") || query.flags.includes("v");
  const ctx: Context = { ignoreCase: query.flags.includes("i"), unicode };
  const literals: Literal[] = [];
  for (const pattern of query.patterns) {
    const source = regexSource(pattern, !query.literal);
    let parsed: AST.Pattern;
    try {
      parsed = new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, {
        unicode: query.flags.includes("u"),
        unicodeSets: query.flags.includes("v"),
      });
    } catch {
      // V8 accepted the pattern at tool entry; syntax the parser lacks only widens the scan.
      return ALL;
    }
    const required = requiredOf(analyzeAlternatives(parsed.alternatives, ctx));
    if (!required) return ALL;
    literals.push(...required);
  }
  const unique = distinct(literals);
  return unique.length > 0 && unique.length <= MAX_LITERALS
    ? { kind: "literals", literals: unique }
    : ALL;
}

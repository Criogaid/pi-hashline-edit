/** Character interpretation, intervals, and membership from the running JavaScript engine. */
import type { AST } from "@eslint-community/regexpp";
export type CharacterNode =
  | AST.Character
  | AST.CharacterClass
  | AST.ExpressionCharacterClass
  | AST.CharacterSet;
type ClassNode =
  | CharacterNode
  | AST.CharacterClassElement
  | AST.ClassIntersection
  | AST.ClassSubtraction;
/** Sorted, disjoint, inclusive code point intervals. */
export type Ranges = readonly (readonly [number, number])[];
export const MAX_UNIT = 0xffff;
export const MAX_SCALAR = 0x10ffff;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const SURROGATE_BLOCK_SIZE = LOW_SURROGATE_END - LOW_SURROGATE_START + 1;
const SUPPLEMENTARY_START = MAX_UNIT + 1;
/** Bound retained native tables independently of the number of queries in a session. */
const MAX_CACHED_SETS = 64;
const MAX_CACHED_RANGES = 16 * 1024;
const MAX_CACHED_SOURCE_UNITS = 8192;
let cachedRanges = 0;
const nativeSets = new Map<string, Ranges>();

/** Without u, two adjacent Character nodes can encode one supplementary code point. */
export function surrogatePair(
  element: AST.Element,
  next: AST.Element | undefined,
): number | undefined {
  if (element.type !== "Character" || next?.type !== "Character") return undefined;
  const [high, low] = [element.value, next.value];
  if (
    high < HIGH_SURROGATE_START ||
    high > HIGH_SURROGATE_END ||
    low < LOW_SURROGATE_START ||
    low > LOW_SURROGATE_END
  )
    return undefined;
  return (
    (high - HIGH_SURROGATE_START) * SURROGATE_BLOCK_SIZE +
    (low - LOW_SURROGATE_START) +
    SUPPLEMENTARY_START
  );
}

export function normalize(ranges: Iterable<readonly [number, number]>): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

export function complement(ranges: Ranges, max: number): Ranges {
  const result: [number, number][] = [];
  let next = 0;
  for (const [low, high] of ranges) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= max) result.push([next, max]);
  return result;
}

export function intersect(left: Ranges, right: Ranges): Ranges {
  const result: [number, number][] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const low = Math.max(left[a][0], right[b][0]);
    const high = Math.min(left[a][1], right[b][1]);
    if (low <= high) result.push([low, high]);
    if (left[a][1] < right[b][1]) a++;
    else b++;
  }
  return result;
}

export function subtract(ranges: Ranges, removed: Ranges): Ranges {
  return intersect(ranges, complement(normalize(removed), MAX_SCALAR));
}

export const total = (ranges: Ranges): number =>
  ranges.reduce((sum, [low, high]) => sum + high - low + 1, 0);
export const contains = (ranges: Ranges, point: number): boolean =>
  ranges.some(([low, high]) => low <= point && point <= high);

/** Full-string membership, including empty alternatives without the final-newline exception of $. */
export const membership = (source: string, flags: string): RegExp =>
  new RegExp(`^(?:${source})(?![\\s\\S])`, flags);

/** The exact single-character part of a validated expression; flags contain only i, s, u or v. */
export function nativeCharacterRanges(source: string, flags: string): Ranges {
  const key = `${flags}:${source}`;
  const cached = nativeSets.get(key);
  if (cached) {
    nativeSets.delete(key);
    nativeSets.set(key, cached);
    return cached;
  }
  const native = membership(source, flags);
  const max = flags.includes("u") || flags.includes("v") ? MAX_SCALAR : MAX_UNIT;
  const ranges: [number, number][] = [];
  let start: number | undefined;
  for (let point = 0; point <= max; point++) {
    if (native.test(String.fromCodePoint(point))) start ??= point;
    else if (start !== undefined) {
      ranges.push([start, point - 1]);
      start = undefined;
    }
  }
  if (start !== undefined) ranges.push([start, max]);
  if (ranges.length <= MAX_CACHED_RANGES && source.length <= MAX_CACHED_SOURCE_UNITS) {
    while (nativeSets.size >= MAX_CACHED_SETS || cachedRanges + ranges.length > MAX_CACHED_RANGES) {
      const oldest = nativeSets.keys().next().value!;
      cachedRanges -= nativeSets.get(oldest)!.length;
      nativeSets.delete(oldest);
    }
    nativeSets.set(key, ranges);
    cachedRanges += ranges.length;
  }
  return ranges;
}

/** Close intervals under V8 case equivalence without shipping a second Unicode version. */
export function foldRanges(ranges: Ranges, unicode: boolean): Ranges {
  if (!ranges.length) return ranges;
  const escape = (point: number) =>
    unicode ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, "0")}`;
  const source = `[${ranges.map(([low, high]) => (low === high ? escape(low) : `${escape(low)}-${escape(high)}`)).join("")}]`;
  return nativeCharacterRanges(source, unicode ? "iu" : "i");
}

/** String representatives of a class; undefined means a string property is not enumerable here. */
export function classStrings(node: ClassNode): readonly string[] | undefined {
  switch (node.type) {
    case "ExpressionCharacterClass":
      return node.negate ? [] : classStrings(node.expression);
    case "ClassIntersection":
      return classStrings(node.left) ?? classStrings(node.right);
    case "ClassSubtraction":
      return classStrings(node.left);
    case "CharacterClass": {
      if (node.negate) return [];
      const result: string[] = [];
      for (const child of node.elements) {
        const strings = classStrings(child);
        if (!strings) return undefined;
        result.push(...strings);
      }
      return result;
    }
    case "ClassStringDisjunction":
      return node.alternatives
        .filter(({ elements }) => elements.length !== 1)
        .map(({ elements }) => elements.map(({ value }) => String.fromCodePoint(value)).join(""));
    case "CharacterSet":
      return node.kind === "property" && node.strings ? undefined : [];
    default:
      return [];
  }
}

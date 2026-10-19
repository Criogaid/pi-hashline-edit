/**
 * JavaScript ignoreCase equivalence, derived from the engine's own definitions:
 * without u/v, ECMA-262 Canonicalize through toUpperCase; with u/v, RegExp itself.
 *
 * @module pi-hashline-edit/core
 */

import { MAX_UNIT, MAX_SCALAR, nativeCharacterRanges } from "./character-set.ts";
const MAX_ASCII = 0x7f;

/** Code units that ignoreCase treats as equal: ECMA-262 Canonicalize without the u flag. */
function equivalentCases(): readonly (readonly number[])[] {
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
  return [...groups.values()].filter((group) => group.length > 1);
}

let unitVariants: ReadonlyMap<number, readonly string[]> | undefined;

function variantsWithoutUnicode(unit: number): readonly string[] | undefined {
  if (!unitVariants) {
    const variants = new Map<number, readonly string[]>();
    for (const group of equivalentCases()) {
      const chars = group.map((member) => String.fromCharCode(member));
      for (const member of group) variants.set(member, chars);
    }
    unitVariants = variants;
  }
  return unitVariants.get(unit);
}

let asciiVariants: readonly (readonly string[])[] | undefined;

/** With u/v, every character that RegExp matches caselessly against each ASCII character. */
function variantsOfAscii(code: number): readonly string[] {
  if (!asciiVariants) {
    const probe = /^[\0-\x7f]$/iu;
    const hits: string[] = [];
    for (let point = 0; point <= MAX_SCALAR; point++) {
      if (point === 0xd800) point = 0xe000;
      const char = String.fromCodePoint(point);
      if (probe.test(char)) hits.push(char);
    }
    asciiVariants = Array.from({ length: MAX_ASCII + 1 }, (_, ascii) => {
      const exact = new RegExp(`^\\x${ascii.toString(16).padStart(2, "0")}$`, "iu");
      return hits.filter((char) => exact.test(char));
    });
  }
  return asciiVariants[code];
}

/**
 * The characters JavaScript's ignoreCase matches for one character, itself included,
 * derived from V8 for Unicode and ECMAScript Canonicalize otherwise.
 */
export function caseVariants(char: string, unicode: boolean): readonly string[] {
  const point = char.codePointAt(0)!;
  if (unicode) {
    if (point <= MAX_ASCII) return variantsOfAscii(point);
    const result: string[] = [];
    for (const [low, high] of nativeCharacterRanges(`\\u{${point.toString(16)}}`, "iu"))
      for (let code = low; code <= high; code++) result.push(String.fromCodePoint(code));
    return result;
  }
  // Without u, ignoreCase never folds a supplementary character's surrogates.
  if (point > MAX_UNIT) return [char];
  return variantsWithoutUnicode(point) ?? [char];
}

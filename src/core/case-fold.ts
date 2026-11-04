/**
 * JavaScript ignoreCase equivalence, derived from the engine itself.
 *
 * @module pi-hashline-edit/core
 */

import { MAX_UNIT, foldRanges } from "./character-set.ts";

/** The characters JavaScript's ignoreCase matches for one character, itself included. */
export function caseVariants(char: string, unicode: boolean): readonly string[] {
  const point = char.codePointAt(0)!;
  // Without u, ignoreCase never folds a supplementary character's surrogates.
  if (!unicode && point > MAX_UNIT) return [char];
  const result: string[] = [];
  for (const [low, high] of foldRanges([[point, point]], unicode))
    for (let code = low; code <= high; code++) result.push(String.fromCodePoint(code));
  return result;
}

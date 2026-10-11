/** Choose rg only when its translated matcher and scan preserve the JS query. */
import { throwIfCancelled } from "./error-text.ts";
import type { GrepQuery } from "../core/search.ts";
import { ripgrepFailure } from "./rg-process.ts";
import type { GrepBackend } from "./grep-search.ts";
import { isTranslationLimit, translateQuery, mayMatchEmpty, type RgMatcher } from "./rg-regex.ts";

export type SearchPlan =
  | { readonly engine: "rg"; readonly matchers: readonly RgMatcher[] }
  | { readonly engine: "javascript"; readonly query: GrepQuery };

export async function planSearch(
  query: GrepQuery,
  rgPath: string,
  backend: GrepBackend,
  signal?: AbortSignal,
): Promise<SearchPlan> {
  let matchers: RgMatcher[];
  try {
    matchers = translateQuery(query);
    if (
      matchers.some((matcher) => matcher.engine === "pcre2" && matcher.multiline) &&
      mayMatchEmpty(query)
    )
      return { engine: "javascript", query };
  } catch (error) {
    // V8 already accepted the syntax; parser and translator limits select the JS path.
    if (isTranslationLimit(error)) return { engine: "javascript", query };
    throw error;
  }
  if (!query.literal) {
    for (const matcher of matchers) {
      const result = await backend.probeRegex(rgPath, matcher, signal);
      throwIfCancelled(signal);
      if (result.code === 0 || result.code === 1) continue;
      if (result.code === 2) return { engine: "javascript", query };
      throw ripgrepFailure("ripgrep could not check the regex.", result);
    }
  }
  return { engine: "rg", matchers };
}

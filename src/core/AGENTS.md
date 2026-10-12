# src/core

Internal pure engine: no Pi imports and no public API. It trusts input already filtered by the tool layer and does not re-validate it. Core's report references are type-only and erased at runtime.

## Modules

- `hash.ts` computes position-dependent line checksums (line number + content → `LINE#HASH`). `lines.ts` handles splitting and line-ending detection. `text.ts` does strict UTF-8 decoding.
- `apply.ts` `applyEdits` validates a whole batch of `Edit` ops (see `types.ts`) against a single snapshot: anchor checks, overlap and conflict detection, and shifted-anchor recovery (`AnchorRecovery`: local `shiftRadius` search, then full file). It returns new text or structured failures and never touches the filesystem.
- `replace.ts` is replace's engine: literal and JavaScript-regex matching on the LF view, separator restoration, and overlap rejection. `replace-schema.ts` defines the tool's replacement schema and the engine's derived rule type.
- `search.ts` evaluates native JavaScript queries on the LF view and returns bounded physical rows; `search-schema.ts` defines its result.
- `search-analysis.ts` parses patterns with regexpp (V8 has already accepted them at tool entry), decides smart case, and derives the literals every match must contain; `case-fold.ts` supplies JavaScript's case equivalence; `character-set.ts` owns character-class sets.
- `errors.ts` holds the classified `HashlineError`, typed by code so its facts and `next` alternative must match the code's schema, and errno classification.
- `ranges.ts` provides overlap detection for both engines and range merging for grep and failure neighborhoods.

## Constraints

- Plan `copy/move` in `apply.ts` against original line ranges; capture text and separators without moving or duplicating the file-header BOM. Treat source reads separately from mutation conflicts, keep destinations in original coordinates, reject interior move destinations, and make adjacent moves no-ops. Reuse the shared commit and Fusion pipeline.
- Own interval algebra, bounded membership caching, and explicit class-string enumeration in `character-set.ts`; derive Unicode properties, `v` sets, and case closure from the running V8 rather than separate Unicode tables. Intersections may enumerate either string operand, subtractions only the left, and unions require every operand. Keep original scoped case flags for membership even when translating a backreference; apply repetition case widening afterward through the existing byte translator. Unknown string properties remain widened.
- Derive necessary file conditions in `search-analysis.ts` as bounded AND/OR literal clauses. Preserve every OR alternative, retain necessary prefixes or suffixes when expansion is too large, and cut literals where bytes can differ from the LF view. Unknown constructs widen candidates, never narrow them.

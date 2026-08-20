# @d3ara1n/pi-hashline-edit

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash (replacing `oldText`/`newText` matching), plus a location-blind `replace` tool for bulk + regex transforms.

Edits reference lines by `LINE#HASH` anchors (copied from `read`/`grep` output) instead of retyping the code to be changed — eliminating string-not-found loops and whitespace battles at the root.

## Why hashline?

The built-in `edit` matches `oldText`/`newText` exactly. When the model can't reproduce the source verbatim — wrong indentation, a non-unique snippet, or a line that drifted since the read — the edit fails and you loop. Hashline sidesteps all of it:

- **No string-not-found loops** — you edit by reference (`LINE#HASH`), not by retyping the line you want to change.
- **No whitespace battles** — the new content is the only thing you type; nothing has to match what's already there. Indentation mistakes on the *old* code are impossible.
- **Unique-by-construction hashes** — the line number is folded into the hash, so identical lines (blank lines, `}`) never share a hash and never collide.
- **Chain edits without re-reading** — a successful `edit` returns fresh anchors for the lines it produced, so the next edit cites them directly instead of forcing a full re-read.
- **Grep-to-edit, no detour** — search results carry the same `LINE#HASH` anchors (grouped by file, context lines included); grab one and edit directly, skipping the read you'd otherwise need.
- **Surgical drift detection** — each cited anchor is rechecked against the current line only; an unrelated change elsewhere never blocks your edit.
- **Self-healing stale anchors** — a drifted anchor (content shifted by an edit above it) doesn't force a full re-read: the applicator rescans ±lines for the original content and hands back a fresh `LINE#HASH` to retry with, only asking for a re-read when the content genuinely changed.

## When to use it

Routine local code editing in pi — the common case. If you spend turns fighting "old_string not found" or fixing indentation the model dropped, this is the fix.

## When to turn it off

Set `hashlineEdit.enabled = false` (or uninstall) to fall back to the built-in `read`/`edit`/`grep` when you need **remote or custom-storage files** — the overrides read/write/search the local filesystem directly, so pi's custom `ReadOperations`/`GrepOperations` (SSH, etc.) aren't supported. The same switch lets you opt out per-project. All four tools — `read`, `grep`, `edit`, `replace` — are one set governed by this switch: when disabled, `read`/`edit` and plain `grep` calls delegate to the built-ins (`grep` calls using the extended params below still run locally, formatted without anchors) and `replace` refuses (it has no built-in counterpart).

## Model compatibility — field notes

Real-world reliability depends on the model more than on anything else. Field observations from real sessions (June 2026, single environment — directional, not benchmarks; vendors iterate fast, re-test on new releases):

| Model profile | Tested example | Built-in string-replace | hashline-edit | Recommendation |
|---|---|---|---|---|
| Weak tool-call construction | DeepSeek V4 Flash | ~50% of edits fail; each fix takes several more `edit` rounds | ~80% of edits fail, but each failure converges in **one** retry | Keep hashline on — fewer total round-trips despite the higher failure rate |
| Strong, but not trained on hashline | Kimi K3 | Excellent | Frequent anchor mistakes | Turn the plugin off — the built-in `edit` serves this profile better |
| Strong, follows the schema as given | GLM 5.2 | Occasional not-found / whitespace friction | 100% — the friction disappears | The intended pairing |

What these numbers actually say:

- **A high failure rate on weak models is not a hashline problem.** DeepSeek V4 Flash fails at ~50% even on plain string-replace — the root cause is misremembered file content, and no edit protocol fixes that. What changes is the *shape* of a failure: string-replace failures are divergent (the model retries from the same wrong memory, so fixes take multiple rounds), while hashline failures are convergent (a mismatched anchor returns the live content plus a ready-to-resend `LINE#HASH`, so one retry closes the loop without trusting the model's memory).
- **Strong ≠ automatic win.** Hashline assumes anchor discipline — copy hashes verbatim from read output, never invent one. A model that hasn't internalized that will fabricate anchors no matter how capable it is. If a strong model keeps hitting anchor errors, the fastest fix is disabling the plugin, not more retries.
- **Some errors are invisible to any edit protocol.** On weak models `insert_after` is sometimes misread as string-replace-style: the model copies the anchor line into `body` (observed on DeepSeek V4 Flash), the toolcall verifies and succeeds, and the line ends up duplicated in the file. Nothing at the tool layer can catch this — the anchor is valid; the model's *intent* was wrong, and no amount of prompt wording cures it (the schema description already forbids the copy). Capable models never needed the wording in the first place: GLM used `insert_after` correctly back when the tool description didn't explain the op at all. The mismatch lives in the model, not the tool.

## Gotchas (vs. the built-in `read`/`edit`)

Once hashline overrides the built-ins, a few things behave differently:

- **`read` is globally overridden.** Every read shows the `LINE#HASH│` prefix on each line — even reads that won't lead to an edit. This is expected (it's the substrate the reliability is built on), just don't be surprised when the format changes for all files.
- **Conservative overlap.** Two ops whose ranges touch (e.g. `insert_after` immediately followed by `replace` at the same line) are rejected to avoid backfill ambiguity — issue them as two separate `edit` calls.

## `replace` — bulk + regex

A separate, location-blind tool for transforms `edit` can't express: replace **all** occurrences of a string/regex across the whole file in one call. Use it for renames, normalizations, and pattern-based rewrites that would otherwise need many individual anchored ops.

- **Two modes** — `regex: false` (default) treats `find` as a literal substring (replaceAll; the replacement is inserted verbatim, no `$` expansion); `regex: true` treats `find` as a JavaScript pattern source and `replace` supports `$1`, `$2`, `$&`, …
- **Flags** — `flags` adds regex flags in both modes (`g` is always forced so every occurrence is replaced): `i` (case-insensitive), `m` (per-line `^`/`$`), `s` (dotall, `.` matches `\n`), `u` (unicode).
- **Safety** — a `maxMatches` cap (default 2000) errors *before writing* if exceeded, so a runaway pattern can't produce a catastrophic write. `0` matches is an error (no silent no-op).
- **Shares the edit queue** — `replace` and `edit` on the same file are serialized via the same mutation queue, so concurrent edits never interleave.
- **Returns a diff + fresh anchors** for the changed region, so a follow-up `edit` can chain on the new content without a re-read (when the region is small).

`edit` vs `replace`: `edit` is **surgical and verified** (you point at a `LINE#HASH` and the tool confirms the line is unchanged before rewriting it). `replace` is **global and unverified** (you give a pattern, it rewrites every match sight-unseen). Pick by intent: change a known spot → `edit`; transform every occurrence → `replace`.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line as `3#aF3│code`; `edit` references `LINE#HASH`. The line number is the address; the hash is a checksum that the line at that address is still what was read.
- **Line folded into the hash**: each line's hash mixes its 1-based line number into its content, so every line is unique by construction — no in-file collisions, no length extension. The hash changes only when the line's own content changes, never when a neighbor changes.
- **Live, surgical verification**: at apply time each cited anchor's hash is recomputed from the current line content and compared — no stored snapshot, no whole-file stale check. A line that changed (or was misremembered) fails its own anchor; an unrelated change elsewhere never blocks the edit. No fuzzy matching, no boundary repair.
- **Shifted-anchor recovery**: a mismatched anchor isn't a dead end. The applicator rescans ±`shiftRadius` lines for the original content — holding the original line number fixed and re-hashing each candidate (`hash(line, candidate) === cited` iff the candidate *is* the original) — and returns a ready-to-resend anchor on a unique hit, the candidate list when ambiguous, or the cited line's live content when nothing matches. The model retries without a re-read in the common drift case.
- **Atomic batches, all failures collected**: every op in one `edit` is verified against the same snapshot; if any anchor fails, *all* failures (each with its recovery) are returned together and nothing is written — partial writes would shift lines and invalidate the very recovery info just returned.
- **Chain edits without re-reading**: a successful `edit` returns `Updated anchors` for the lines it produced (and the line that shifted into a deletion gap), so the next edit can cite them directly.
- **No legacy compatibility on `edit`**: `edit` accepts only structured hashline ops; sending legacy `oldText`/`newText` is rejected at the schema layer (never silently degrades) — so you always know whether hashline is actually in use. Bulk/regex replacement is a *separate* tool, `replace`, not an `edit` mode (see below).

## Protocol

`read` output (each line anchored):

```
src/foo.ts · 6 lines
1#aF3│import { compute } from "./util"
2#7Qk│
3#mP0│export function foo(x: number) {
```

`grep` output (results grouped by file, each line anchored — copy `LINE#HASH` straight into an edit):

```
src/foo.ts · 2 matches
3#mP0│export function foo(x: number) {
4#kLp│  return x + 1
src/util.ts · 1 match
10#aF3│  const z = compute(x)
```

The `grep` override also covers the compound queries that otherwise push models into bash pipelines:

- `matchMode: "all"` — a line must match **every** pattern (`grep A | grep B` without the pipe)
- `excludePattern` — drop matching lines (`grep -v`), applied after pattern matching
- `wordMatch` — whole words only (`rg -w`)
- `outputMode: "files"` / `"count"` — just the file paths (`rg -l`) or per-file counts + total (`grep -c`); `"files"` output pastes straight back as a `path` array
- `pattern` and `path` accept arrays — several patterns combined per `matchMode`, several search roots in one call

Filters run before the match limit counts, and context windows are rebuilt from surviving matches, so `limit` and `context` compose cleanly with `matchMode`/`excludePattern`.


`edit` takes `path` + `edits` (an array of ops, each with `op`, `anchor`/`end` `{line, hash}` from read, and `body` string[]):

```jsonc
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "anchor": { "line": 4, "hash": "kLp" }, "body": ["  return x + 1"] },
    { "op": "insert_after", "anchor": { "line": 6, "hash": "b2H" }, "body": ["", "export const bar = foo"] }
  ]
}
```

Ops: `replace` · `delete` · `insert_after` · `insert_before` · `append` · `prepend`. `anchor`/`end` = `{line, hash}` from read; `body` = new content lines (string[], omit for `delete`).

`replace` takes `path`, `find`, `replace` (+ optional `regex`, `flags`, `maxMatches`) and substitutes **every** match:

```jsonc
{
  "path": "src/foo.ts",
  "find": "oldName",
  "replace": "newName"
}
```

Regex with a capture group (rename `getName()` → `get_name()` everywhere):

```jsonc
{ "path": "src/foo.ts", "find": "get([A-Z]\w*)", "replace": "get_$1", "regex": true }
```

Case-insensitive literal rename across the whole file:

```jsonc
{ "path": "src/foo.ts", "find": "TODO", "replace": "FIXME", "flags": "i" }
```

## Configuration

Add a `hashlineEdit` field to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in a project (project replaces global):

```jsonc
{
  "hashlineEdit": {
    "enabled": true,     // set false to fall back to the built-in read/edit
    "hashLen": 4,        // hash length, 2–8 (default 4)
    "shiftRadius": 15    // ±lines scanned to rescue a stale anchor (default 15; 0 disables)
  }
}
```

## Installation

```bash
pi install npm:@d3ara1n/pi-hashline-edit
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-hashline-edit"
  ]
}
```

## Dependencies

- No additional `@d3ara1n/pi-*` dependencies; peer `@earendil-works/pi-coding-agent` ships with pi (framework-level, not listed by convention).

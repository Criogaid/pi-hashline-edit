# @d3ara1n/pi-hashline-edit

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash, replacing `oldText`/`newText` matching.

Edits reference lines by `LINE#HASH` anchors (copied from `read` output) instead of retyping the code to be changed — eliminating string-not-found loops and whitespace battles at the root.

## Why hashline?

The built-in `edit` matches `oldText`/`newText` exactly. When the model can't reproduce the source verbatim — wrong indentation, a non-unique snippet, or a line that drifted since the read — the edit fails and you loop. Hashline sidesteps all of it:

- **No string-not-found loops** — you edit by reference (`LINE#HASH`), not by retyping the line you want to change.
- **No whitespace battles** — the new content is the only thing you type; nothing has to match what's already there. Indentation mistakes on the *old* code are impossible.
- **Unique-by-construction hashes** — the line number is folded into the hash, so identical lines (blank lines, `}`) never share a hash and never collide.
- **Chain edits without re-reading** — a successful `edit` returns fresh anchors for the lines it produced, so the next edit cites them directly instead of forcing a full re-read.
- **Surgical drift detection** — each cited anchor is rechecked against the current line only; an unrelated change elsewhere never blocks your edit.
- **Self-healing stale anchors** — a drifted anchor (content shifted by an edit above it) doesn't force a full re-read: the applicator rescans ±lines for the original content and hands back a fresh `LINE#HASH` to retry with, only asking for a re-read when the content genuinely changed.

## When to use it

Routine local code editing in pi — the common case. If you spend turns fighting "old_string not found" or fixing indentation the model dropped, this is the fix.

## When to turn it off

Set `hashlineEdit.enabled = false` (or uninstall) to fall back to the built-in `read`/`edit` when you need **remote or custom-storage files** — the override reads/writes the local filesystem directly, so pi's custom `ReadOperations` (SSH, etc.) aren't supported. The same switch lets you opt out per-project.

## Gotchas (vs. the built-in `read`/`edit`)

Once hashline overrides the built-ins, a few things behave differently:

- **`read` is globally overridden.** Every read shows the `LINE#HASH│` prefix on each line — even reads that won't lead to an edit. This is expected (it's the substrate the reliability is built on), just don't be surprised when the format changes for all files.
- **`grep` results don't carry hashes.** pi's grep isn't overridden, so matches come back without `LINE#HASH`. To edit a file you first spotted via grep, `read` it to get the anchors first.
- **Conservative overlap.** Two ops whose ranges touch (e.g. `insert_after` immediately followed by `replace` at the same line) are rejected to avoid backfill ambiguity — issue them as two separate `edit` calls.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line as `3#aF3│code`; `edit` references `LINE#HASH`. The line number is the address; the hash is a checksum that the line at that address is still what was read.
- **Line folded into the hash**: each line's hash mixes its 1-based line number into its content, so every line is unique by construction — no in-file collisions, no length extension. The hash changes only when the line's own content changes, never when a neighbor changes.
- **Live, surgical verification**: at apply time each cited anchor's hash is recomputed from the current line content and compared — no stored snapshot, no whole-file stale check. A line that changed (or was misremembered) fails its own anchor; an unrelated change elsewhere never blocks the edit. No fuzzy matching, no boundary repair.
- **Shifted-anchor recovery**: a mismatched anchor isn't a dead end. The applicator rescans ±`shiftRadius` lines for the original content — holding the original line number fixed and re-hashing each candidate (`hash(line, candidate) === cited` iff the candidate *is* the original) — and returns a ready-to-resend anchor on a unique hit, the candidate list when ambiguous, or the cited line's live content when nothing matches. The model retries without a re-read in the common drift case.
- **Atomic batches, all failures collected**: every op in one `edit` is verified against the same snapshot; if any anchor fails, *all* failures (each with its recovery) are returned together and nothing is written — partial writes would shift lines and invalidate the very recovery info just returned.
- **Chain edits without re-reading**: a successful `edit` returns `Updated anchors` for the lines it produced (and the line that shifted into a deletion gap), so the next edit can cite them directly.
- **No legacy compatibility**: `edit` accepts only structured hashline ops; sending legacy `oldText`/`newText` is rejected at the schema layer (never silently degrades) — so you always know whether hashline is actually in use.

## Protocol

`read` output (each line anchored):

```
src/foo.ts · 6 lines
   1#aF3│import { compute } from "./util"
   2#7Qk│
   3#mP0│export function foo(x: number) {
```

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

# @d3ara1n/pi-hashline-edit

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash, replacing `oldText`/`newText` matching.

Edits reference lines by `LINE#HASH` anchors (copied from `read` output) instead of retyping the code to be changed — eliminating string-not-found loops and whitespace battles at the root.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line with a short hash (`3#aF3│code`); `edit` references `LINE#HASH`. The line number is the address; the hash is a checksum that the line at that address is still what was read.
- **Line + content hash**: each line's hash mixes its 1-based line number into its content, so every line gets a unique hash by construction — no in-file collisions, no length extension. The hash changes only when the line's own content changes, never when a neighbor changes.
- **Live, surgical verification**: at apply time each cited anchor's hash is recomputed from the CURRENT line content and compared — no stored snapshot, no whole-file stale check. A line that changed (or was misremembered) fails its own anchor; an unrelated change elsewhere never blocks the edit. No fuzzy matching, no boundary repair, no drift relocation.
- **Chain edits without re-reading**: a successful `edit` returns `Updated anchors` (`LINE#HASH│`) for the lines it produced (and the line that shifted into a deletion gap), so the next edit to the same file can cite them directly.
- **No legacy compatibility**: overrides the built-in `edit`/`read`. `edit` accepts only structured hashline ops; sending legacy `oldText`/`newText` is rejected at the schema layer (never silently degrades) — so you always know whether hashline is actually in use.

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

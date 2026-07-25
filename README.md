# @d3ara1n/pi-hashline-edit

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash, replacing `oldText`/`newText` matching.

Edits reference lines by `LINE#HASH` anchors (copied from `read` output) instead of retyping the code to be changed — eliminating string-not-found loops and whitespace battles at the root.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line with a short hash (`3#aF3│code`); `edit` references `LINE#HASH`. The line number is for humans, the hash for the machine — naturally resilient to line drift.
- **Context-aware hash**: each line's hash incorporates its neighbors, so identical lines (blank lines, `}`) get different hashes when their context differs — in-file collisions approach zero.
- **Strict core + pluggable tolerance**: the core `parse → apply` makes zero guesses and fails fast; tolerance (boundary repair, drift relocation, block ops) is layered as independently toggleable middleware.
- **No legacy compatibility**: overrides the built-in `edit`/`read`. `edit` accepts only the hashline `input`; sending legacy `oldText`/`newText` returns an explicit error (never silently degrades) — so you always know whether hashline is actually in use.

## Protocol

`read` output (each line anchored):

```
src/foo.ts · 6 lines
   1#aF3│import { compute } from "./util"
   2#7Qk│
   3#mP0│export function foo(x: number) {
```

`edit` `input` — `path` is a tool parameter; `input` holds only ops (no `file:` header, the tool injects it):

```
replace 4#kLp:
+  if (x < 0) throw new Error("neg")

insert_after 6#b2H:
+
+export const bar = foo
```

Ops: `replace LINE#HASH[..LINE#HASH]:` · `delete LINE#HASH` · `insert_after LINE#HASH:` · `insert_before LINE#HASH:` · `append:` · `prepend:`. Body rows start with `+`; `+` alone is a blank line; literal `+`/`-` lines become `++`/`+-`.

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

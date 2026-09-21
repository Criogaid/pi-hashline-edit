# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

> Hashline-style local file tools for [pi](https://github.com/earendil-works/pi-coding-agent) — `read` and `grep` emit content-verified `LINE#HASH` anchors, `edit` applies surgical anchored changes, `replace` handles whole-file string/regex transforms, and `write` publishes complete content safely.

All five tools replace pi's local-filesystem toolset as one switchable unit. Optional Hashline Fusion attaches a `then_run` command to a successful `edit`/`replace`/`write` mutation, with file-scoped serialization and explicit publication, command, and freshness state.

This repository is the standalone home of the implementation. The `@criogaid` release line starts at `0.1.0`; pre-split Git history is retained for provenance, while releases of the former `@d3ara1n` package belong to that package and are not releases of this one.

## Why hashline?

The built-in `edit` matches `oldText`/`newText` exactly. When the model can't reproduce the source verbatim — wrong indentation, a non-unique snippet, or a line that drifted since the read — the edit fails and you loop. Hashline sidesteps all of it:

- **No string-not-found loops** — you edit by reference (`LINE#HASH`), not by retyping the line you want to change.
- **No whitespace battles** — the new content is the only thing you type; nothing has to match what's already there. Indentation mistakes on the *old* code are impossible.
- **Position-aware checksums** — the line number is folded into the hash, so repeated content at different positions normally gets different anchors. The short hash is a checksum, not a collision-proof identifier.
- **Chain edits without re-reading** — a successful `edit` returns fresh anchors for the lines it produced, so the next edit cites them directly instead of forcing a full re-read.
- **Grep-to-edit, no detour** — search results carry the same `LINE#HASH` anchors (grouped by file, context lines included); grab one and edit directly, skipping the read you'd otherwise need.
- **Surgical drift detection** — each cited anchor is rechecked against the current line only; an unrelated change elsewhere never blocks your edit.
- **Conservative stale-anchor recovery** — a drifted anchor (often content shifted by an edit above it) doesn't force an immediate full re-read: the applicator rescans ±lines and can hand back a checksum-matching `LINE#HASH` candidate to retry. It never auto-applies recovery; if the match is absent or ambiguous, the error includes bounded current-file anchors so the model can re-evaluate and submit a newly verified edit.

## When to use it

Routine local code editing in pi — the common case. If you spend turns fighting "old_string not found" or fixing indentation the model dropped, this is the fix.

## When to turn it off

Set `hashlineEdit.enabled = false` (or uninstall) to fall back to the built-in `read`/`edit`/`grep`/`write` when you need **remote or custom-storage files** — the overrides read/write/search the local filesystem directly, so pi's custom `ReadOperations`/`GrepOperations` (SSH, etc.) aren't supported. The same switch lets you opt out per-project. All five tools — `read`, `grep`, `edit`, `replace`, `write` — are one set governed by this switch: when disabled the extension registers none of them and pi behaves as if it were not installed (reload pi after changing the setting).

## Model Compatibility

Hashline replaces the edit protocol the main model was trained on, so real-world reliability depends on the model more than on anything else. Field observations from real sessions, one family per subsection (June 2026, single environment — directional, not benchmarks; vendors iterate fast, re-test on new releases).

### DeepSeek family

**Avoid — silent corruption.** Weak tool-call construction (tested: DeepSeek V4 Flash): ~50% of edits fail on the built-in string-replace, and each fix takes several more rounds — string-replace failures are *divergent*, the model retries from the same wrong memory, but at least they are loud. Hashline's rejected anchors *converge* — a mismatched anchor returns the live content plus a ready-to-resend `LINE#HASH`, so one retry closes the loop — but the raw failure rate is high (~80%), and hashline adds a failure class the built-in edit doesn't have.

`insert_after` semantics invite wrong parameters even when the tool call itself is well-formed: the model fills `body` string-replace-style, copying the anchor line into it (observed on DeepSeek V4 Flash). The toolcall verifies and succeeds, and the line ends up duplicated. Nothing at the tool layer can catch this — the anchor is valid, the model's *intent* was wrong, and no prompt wording cures it (the schema description already forbids the copy). For a weak model, hashline effectively trades loud failures for silent ones: files come out corrupted edit by edit. Keep the plugin off for this profile; if you must run it, review the diff after every edit.

### Kimi family

**Turn the plugin off.** Strong, but not trained on hashline (tested: Kimi K3): built-in string-replace is excellent while hashline draws frequent anchor mistakes. Hashline assumes anchor discipline — copy hashes verbatim from read output, never invent one; a model that hasn't internalized that fabricates anchors no matter how capable. When a strong model keeps hitting anchor errors, the fastest fix is disabling the plugin, not more retries.

### GLM family

**The intended pairing.** Strong and follows the schema as given (tested: GLM 5.2): the occasional not-found / whitespace friction of built-in string-replace disappears — 100% in testing. Capable models never needed the wording in the first place: GLM used `insert_after` correctly even when the tool description didn't explain the op at all. The mismatch lives in the model, not the tool.

### GPT family

**No reservations.** Structured ops are home turf for this family (tested: GPT 5.6 sol/terra/luna): no fabricated or mistyped anchors observed, and `insert_after` was never misused — the anchor-line-into-`body` duplication (see DeepSeek above) never occurred. The few rejected anchors were the *expected* kind: a size-changing `edit` invalidating the hashes of the lines below it between edits — the documented hash-drift tradeoff rather than a model error, and exactly what the self-healing rescan exists to rescue. Even those ran fewer than expected; small-sample observation, take it directionally.

## Gotchas (vs. the built-in `read`/`edit`)

Once hashline overrides the built-ins, a few things behave differently:

- **`read` is globally overridden.** Every read shows the `LINE#HASH│` prefix on each line — even reads that won't lead to an edit. This is expected (it's the substrate the reliability is built on), just don't be surprised when the format changes for all files.
- **Conservative overlap.** Two ops whose ranges touch (e.g. `insert_after` immediately followed by `replace` at the same line) are rejected to avoid backfill ambiguity — issue them as two separate `edit` calls.

## `replace` — bulk + regex

A separate, location-blind tool for transforms `edit` can't express: replace **all** occurrences of a string/regex across the whole file in one call. Use it for renames, normalizations, and pattern-based rewrites that would otherwise need many individual anchored ops.

- **Two modes** — `regex: false` (default) treats `find` as a literal substring (replaceAll; the replacement is inserted verbatim, no `$` expansion); `regex: true` treats `find` as a JavaScript pattern source and `replace` supports `$1`, `$2`, `$&`, …
- **Flags** — `flags` adds regex flags in both modes (`g` is always forced so every occurrence is replaced): `i` (case-insensitive), `m` (per-line `^`/`$`), `s` (dotall, `.` matches `\n`), `u` (unicode).
- **Safety** — a `maxMatches` cap (default 2000) errors *before writing* if exceeded. `0` matches is an error (no silent no-op). The match-count cap does not bound regex execution time or result size.
- **Shares the edit queue** — `replace` and `edit` on the same file are serialized via the same mutation queue, so concurrent edits never interleave.
- **Returns a diff + fresh anchors** for the changed region, so a follow-up `edit` can chain on the new content without a re-read (when the region is small).

`edit` vs `replace`: `edit` is **surgical and checksum-guarded** (you point at `LINE#HASH` anchors and the tool verifies the supplied checksums before rewriting). `replace` is **global and unanchored** (you give a pattern, it rewrites every match). Pick by intent: change a known spot → `edit`; transform every occurrence → `replace`.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line as `3#AF32│code`; `edit` references `LINE#HASH`. The line number is the address; the hash is a short checksum of the observed `(line number, content)` pair.
- **Line folded into the hash**: each line's hash mixes its 1-based line number into its content. This disambiguates repeated content in normal use, but the truncated 32-bit checksum can collide and is not an identity credential. The hash changes when either the content or line number changes; editing a neighbor in place does not affect it.
- **Windowed hash computation**: `read` computes line hashes only for its requested window; `grep` computes them only for selected matches and context. Both retain whole-file reading and decoding, existing output limits, and original line numbers. Mutation revision checks remain unchanged.
- **Live, surgical verification**: at apply time each supplied anchor's hash is recomputed from the current line content and compared — no stored snapshot, no whole-file stale check. A changed cited line normally fails its anchor, though short-checksum collisions are possible; an unrelated in-place change elsewhere does not. For a range, the current protocol carries only start and end anchors, so interior before-image verification requires the planned read-receipt protocol. Insertions or deletions above the target trigger shifted-anchor recovery instead of silently retargeting the edit. No fuzzy matching, no boundary repair.
- **Shifted-anchor recovery**: a mismatched anchor isn't a dead end. The applicator rescans ±`shiftRadius` lines while holding the cited line number fixed and re-hashing each candidate. A unique checksum match is offered as a retry candidate; collisions or repeated candidates can be ambiguous, so recovery never auto-applies. When the content cannot be recovered, the failure includes a bounded `LINE#HASH│content` window from the validation snapshot; the model must re-evaluate the intended change, and every retry is verified again.
- **Atomic batches, all failures collected**: every op in one `edit` is verified against the same snapshot. If any anchor fails, nothing is written; the result reports failure counts and bounded recovery details. Retries always re-verify the supplied anchors.
- **Chain edits without re-reading**: a successful `edit` returns `Updated anchors` for the lines it produced (and the line that shifted into a deletion gap), so the next edit can cite them directly.
- **Byte-faithful writes**: `edit` rewrites only the lines you name. CRLF files keep CRLF, and a file whose last line has no terminator does not gain one — the state `splitLines` discards is captured before the edit and restored after it. `read` states the fact in its header (`· no trailing newline`), since the numbered rows cannot show it.
- **BOM and output encoding**: `edit` keeps an existing UTF-8 BOM at byte zero when replacing/deleting the first line or inserting before it; deleting all content leaves the BOM. First-line anchor hashes still include the original BOM. A copied leading BOM in the first replacement/insertion line denotes that existing header; interior `U+FEFF` characters are preserved. A BOM-only file retains its existing one-line anchor representation. `write` uses its supplied content exactly, and `replace` retains explicit BOM matching. All mutations reject strings that cannot be encoded losslessly as UTF-8 before publication.
- **No legacy compatibility on `edit`**: `edit` accepts only structured hashline ops; sending legacy `oldText`/`newText` is rejected at the schema layer (never silently degrades) — so you always know whether hashline is actually in use. Bulk/regex replacement is a *separate* tool, `replace`, not an `edit` mode (see below).

## Why line hashes, not file tags

### The short version

This plugin is a line-hash editor: every line comes back tagged with a content hash that folds in its line number, and you edit by citing that `LINE#HASH`. That is, deliberately, the *original* hashline idea — the one omp shipped in February 2026 and then walked away from. omp's current engine anchors on a **whole-file** hash instead, and has since mid-2026. I looked at that route and stayed on the line-hash one on purpose. What follows is my case for that choice, stated as a tradeoff rather than a verdict — the honest limitations, including the ones that argue for the other route, come right after.

### Where this comes from

The idea that a model should edit by pointing at a **stable, verifiable anchor** instead of retyping code it already saw is not mine — it is can1357's, argued in [*The Harness Problem*](https://blog.can.ac/2026/02/12/the-harness-problem/) (2026-02-12), and omp's first implementation was exactly this shape: every read line tagged with a short per-line content hash, edits expressed as structured `old`/`new` ops. That first design had a real problem, and omp and I fixed it in opposite directions.

**Identical content hashes collide systematically.** A hash of line content alone gives every `}`, every `)`, and every blank line the same value. omp's fix was to stop hashing lines and hash the **whole file** instead: a 4-hex file tag, with no per-line hash in `read` output at all. This plugin folds the line number into each line's hash, so identical text at different positions normally differs without file-level state. As with every truncated checksum, unrelated `(line, content)` pairs can still collide.

That single divergence cascades into everything else. (It also means the picture most people have of "hashline" is the line-hash one: omp's own docs site still describes per-line anchors that its current implementation no longer emits.)

### The case against the file-tag route

I can't speak to omp's motives for the switch — collision-proofing a per-line hash is hard, and the file tag sidesteps it entirely. But the clearest *payoff* I see in a whole-file tag is one my design gives up: **awareness of edits made by anyone else.** If another process touches the file, its whole-file tag changes, the next anchored edit is rejected, and the model is forced to re-read fresh state. For a swarm of agents editing one tree, that is a genuinely good property. It costs three things I wasn't willing to pay:

- **The tag can't tell whether the model actually *read* a line.** A whole-file hash proves the file is byte-for-byte what it was, not that the model saw the specific line it is rewriting. omp therefore carries a separate `seenLines` guard. A per-line anchor is compact evidence that the line was observed, but because the checksum is short and forgeable it is not a cryptographic proof of observation.
- **It needs out-of-band state.** A 16-bit file tag "is not meaningful outside that store" (omp's own words) — it can collide, so omp keeps a `SnapshotStore`, an LRU of recent file versions, to disambiguate. My hashes are content-derived and self-contained: an anchor is verified by rehashing the current line at that number, at apply time, against nothing but the file on disk. **This plugin has no SnapshotStore, no seenLines array, nothing to keep in sync.** That is the point, not an omission.
- **The verification is coarse.** A whole-file tag couples every edit to the entire file: an unrelated change *anywhere* invalidates the tag and drags the whole patch through recovery. Line hashes verify only the lines you cite — an unrelated edit elsewhere never blocks you.

### Why a JSON schema, not a text DSL

The other visible difference: omp delivers edits as a **text patch language** (`PUT`/`CUT`/`REM`/`MV` today, `SWAP`/`DEL`/`INS` before that, JSON before *that*). This plugin uses **structured JSON ops**. Two reasons:

- **Validation belongs to the tool, not the model.** A JSON schema rejects a malformed op at the parameter layer before any logic runs. A text DSL puts the burden of emitting exactly-correct syntax back on the model, and the error rate is high enough that the DSL route accretes layer after layer of lenient parsing and heuristic repair to compensate — omp has shipped both, including a documented incident where the repair silently dropped content. The whole reason to anchor by hash was to stop depending on the model reproducing text perfectly; a hand-written DSL quietly reintroduces that dependency on the other side of the call.
- **The token savings aren't worth it.** A DSL saves a handful of structural characters per op. Against a higher malformed-edit rate and the cost of format churn — omp's patch syntax has broken compatibly five-plus times, stranding third-party ports on dead dialects — that saving is noise.

### Compared by capability

Not by version: omp's later generations refine the same whole-file-tag core, so the real comparison is *line-hash route* vs *file-tag route*.

| Capability | This plugin (line-hash) | omp (file-tag) |
|---|---|---|
| Anchor identity | per-line `LINE#HASH`, line number folded in | whole-file 4-hex `#TAG`, bare line numbers |
| Repeated-line disambiguation | line number prevents systematic same-content anchors; checksum collisions remain possible | n/a (no per-line hash); the file tag itself can collide in 16 bits |
| Out-of-band state | **none** | `SnapshotStore` (LRU) + `seenLines` guard |
| "Did the model read this line?" | compact anchor evidence, not collision-proof proof | needs the separate `seenLines` array |
| Verification granularity | only the cited lines (surgical) | whole file — any drift enters recovery |
| Concurrent external edits | not a goal; re-read to proceed | detected by design — tag change forces a re-read |
| Wire format | JSON schema ops | text patch DSL |
| Malformed edits | rejected at the schema layer | lenient parsing + heuristic repair |
| Format stability | one schema | ≥5 breaking format generations |
| Drift recovery | ±15-line rescan → fresh anchor, else re-read | line-remap replay, fail-closed |
| Expressiveness | fine-grained ops + separate `replace` | syntax blocks, cross-file registers, `REM`/`MV` |
| Read-time token cost | 2–4 chars per line | none at read time; cost moves to mismatch output |

### Honest limitations

Including the ones that argue *for* the route I didn't take.

- **Hash drift after an edit.** Because the line number is part of the hash, inserting or deleting lines changes every subsequent line's hash. A successful edit hands back fresh anchors for the region it just produced, and the ±15-line rescan rescues nearby drift — but to cite lines well below a size-changing edit, you re-read. That is the price of stateless verification: I keep no snapshot that would track those shifts for you. I consider it a fair trade for having no out-of-band state to corrupt or resync; a clean core matters more to me than saving a read.
- **Short-hash collisions.** The default four Crockford Base32 characters expose at most 20 bits from a 32-bit non-cryptographic hash. Anchors are stale-edit checksums, not unique IDs or security credentials; a future read-receipt protocol is required for strong observation identity and complete multi-line before-image validation.
- **No multi-agent story.** If several agents edit one tree, the file-tag route's external-edit detection is a real advantage this design does not have.
- **Hash transcription is itself error-prone.** Anchoring assumes the model copies the hash verbatim. It doesn't always: *"It sees `483:d4` in the input, writes `483:3a` in the output. Every model does this, including Opus."* ([geometricagi, *AST Edits*](https://geometricagi.github.io/2026/04/02/ast-edits.html), 2026-04-02). This is a failure class the built-in string-replace does not have — see Model Compatibility above; on a model that hasn't internalized anchor discipline, turn the plugin off rather than fight it.
- **The edit format may not be your bottleneck at all.** An independent benchmark ([nwyin, *edit-bench*](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html)) found the hashline-vs-replace delta to be language-dependent — a real penalty on Python, neutral on TypeScript, a wash on Rust — and concluded that *"edit format is not the bottleneck"*: model-to-model differences dwarf format-to-format ones. It also found that the whitespace near-miss anchoring is meant to kill barely occurs — fuzzy matching triggered 0 times across 114 successful edits.
- **A silent success is worse than a loud failure.** Any anchor scheme is only as safe as its implementation. opencode's early hashline port returned `Updated` while writing to the wrong line ([issue #15424](https://github.com/anomalyco/opencode/issues/15424)) — a buggy anchor check manufactures false trust. This plugin's recovery is built to fail closed and hand back live content instead of guessing, but the warning generalizes.
- **Model dependence is real and not universally in my favor.** omp routes kimi, mimo, deepseek-v4-flash and step-3.7-flash *away* from hashline by default (they miscount anchors or drop the tag header). My own field notes agree on Kimi and disagree on DeepSeek — same model, opposite conclusions in different environments. There is no globally best edit format; there is a model × task × implementation triple.

## Protocol

`read` output (each line anchored):

```
src/foo.ts · 6 lines
1#AF32│import { compute } from "./util"
2#7QK3│
3#MP04│export function foo(x: number) {
```

`grep` output (results grouped by file, each line anchored — copy `LINE#HASH` straight into an edit):

```
src/foo.ts · 2 matches
3#MP04│export function foo(x: number) {
4#K7P2│  return x + 1
src/util.ts · 1 match
10#AF32│  const z = compute(x)
```

The `grep` override also covers the compound queries that otherwise push models into bash pipelines:

- `matchMode: "all"` — a line must match **every** pattern (`grep A | grep B` without the pipe)
- `excludePattern` — drop matching lines (`grep -v`), applied after pattern matching
- `wordMatch` — whole words only (`rg -w`)
- `outputMode: "files"` / `"count"` — just the file paths (`rg -l`) or per-file counts + total (`grep -c`); `"files"` output pastes straight back as a `path` array
- `pattern` and `path` accept arrays — several patterns combined per `matchMode`, several search roots in one call
- `noIgnore` — include files excluded by `.gitignore`, `.ignore`, or `.rgignore`; explicit `glob` filters still apply
- `follow` — traverse symbolic links and return resolved target paths
- `pcre2` — opt into PCRE2 lookarounds and backreferences; this is strict regex mode and cannot be combined with `literal: true`
- `multiline` — allow matches across physical lines; results, filtering, limits, and counts remain line-based, and `.` crosses line breaks only with inline `(?s)`

Filters run before the match limit counts, and context windows are rebuilt from surviving matches, so `limit` and `context` compose cleanly with `matchMode`/`excludePattern`. `files` and `count` use the same limited set of matching physical lines; they are not unlimited repository totals.

All inclusion and exclusion patterns are evaluated by ripgrep. The default engine is ripgrep's standard Rust regex engine with query-level smart-case; `pcre2: true` selects the bundled PCRE2 engine without silently changing engines or falling back to literal text. Searches are CRLF-aware and single-line by default. The extension passes `--no-config`, includes hidden files while retaining ignore rules, and invokes the platform-specific binary installed through `@vscode/ripgrep`, independent of a system `rg` or `PATH`.

Non-empty wildcard-only regexes such as `.*` and `^.+$` are accepted under the same output limits. Use `literal: true` to search for those characters verbatim.

`edit` takes `path` + `edits`. Copy `anchor` and `end` directly as `"LINE#HASH"` strings; `body` contains the new lines:

```jsonc
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "anchor": "4#K7P2", "body": ["  return x + 2"] },
    { "op": "insert_after", "anchor": "6#B2H4", "body": ["", "export const bar = foo"] }
  ]
}
```

Ops: `replace` · `delete` · `insert_after` · `insert_before` · `append` · `prepend`. Replace/delete affect only the anchor line unless an inclusive `end` is supplied. To change multiple existing lines, supply both anchors. Insert operations keep the anchor line and accept no `end`; append/prepend accept neither anchor. `body` is required except for delete, which accepts no body. Conflicting fields are rejected before publication.

**Migration:** Object anchors (`{ "line": 4, "hash": "K7P2" }`) are no longer accepted by the tool. Use `"4#K7P2"` instead, including in saved calls and retry code. Core library anchors remain objects.

Successful `write` results include a revision and compact anchor tokens (up to 40), without echoing the content just supplied. Edit/replace results retain complete changed-line content, capped at 40 anchor rows and 16 KiB for the anchor section including its heading and omission notice. Rows that do not fit are omitted whole, never returned as partial editable lines. Anchor-mismatch diagnostics have a 16 KiB total budget, at most 40 detailed failures, and at most eight candidates per ambiguous failure; omitted details require a fresh read. Parameter rules live in the schemas; prompt guidelines cover only tool selection and batching.

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
    "enabled": true,     // set false to disable the extension entirely (built-ins remain; reload pi)
    "actionFusion": false, // set true to expose then_run on edit/replace/write
    "hashLen": 4,        // integer hash length, 2–8 (default 4)
    "shiftRadius": 15    // integer recovery radius, 0–100 (default 15; 0 disables)
  }
}
```

When `actionFusion` is true, `edit`, `replace`, and `write` accept an optional `then_run` object. The mutation runs first; a successful mutation is followed by the command using the same file-scoped Hashline Fusion queue. A command failure does not roll back the mutation. Once the mutation returns successfully, a subsequent command failure is returned in the result's text and `details.actionFusion`, rather than thrown as a failure of the whole tool call. Consumers must inspect the command status separately. Mutation failures still throw, including failures to finish mutation result generation after publication. The command uses Pi's built-in Bash definition directly and does not create a separate Bash tool call, so Bash-only approval or sandbox extensions must explicitly account for `edit.then_run`, `replace.then_run`, and `write.then_run`.
`write` preserves Pi's complete-content `{ path, content }` shape. By default it creates missing files and overwrites existing files. `mode: "create"` refuses an existing target; `mode: "overwrite"` requires an existing target; `expectedRevision` is optional, but is checked strictly when supplied. Hashline does not automatically strip `LINE#HASH│` prefixes from write content.
The setting is disabled by default. Keep it false when commands should not be available from Hashline mutations.

Malformed settings objects and invalid field values fall back to the applicable defaults. `hashLen` and `shiftRadius` must be integers within their documented ranges.

In the TUI, each `then_run` gets a separate transcript card showing the command, waiting/running state, live output, and final outcome. The main `edit`/`replace`/`write` card switches to its success background as soon as mutation execution and result generation succeed, while the command card stays pending until its own outcome is known. Streaming updates expose this distinction through `details.actionFusion.mutationCompleted`; file publication alone is not mutation success. If the mutation succeeded but the command failed, the main card retains its successful mutation preview/diff and only the command card shows the failure. Command output is not repeated in the main card. Cards reuse Pi's native Bash command and output renderers, including the collapsed output preview and expand hint, with the same pending/success/error background colors as native tools. Expand them to inspect the captured output. Cards preserve their final state across session reloads without adding messages to model context. If the session ended before a final outcome was saved, the card reports an interrupted command with unknown final status. RPC hosts receive the same progress through tool execution updates; rendering depends on the host.

Fusion errors tell the model whether file changes were saved and whether the command ran. When a requested command leaves freshness anything other than explicitly `unchanged`, pre-command anchors from `write`, `edit`, and `replace` are omitted and the result requests a fresh read. Streaming mutation summaries do not contain anchors. Without a command (including when Fusion is disabled), anchors are exposed only when the commit's `observedRevision` equals its `publishedRevision`. This is an observation at result preparation time; later edits still verify their anchors. Structured publication, command, and freshness states remain available to the card and other consumers. Progress callback failures are reported as display diagnostics without changing the mutation or command outcome.

### File publication boundaries

All three mutation tools use the same `commitFile` layer. Complete content is prepared in a sibling temporary directory and synced before publication.

- `mode: "create"` publishes with same-filesystem `link(temp, target)`, so a target that appears during the race is rejected rather than overwritten.
- Replacement publishes with `rename(temp, target)` and never deletes the old target first.
- Existing symlinks are resolved for overwrite and preserved; dangling or unresolvable symlinks are rejected.
- Existing regular files with multiple hard links are rejected instead of silently splitting the link set.
- Existing permission bits are copied to the replacement; new files are created with `0600`, which is also their final default mode. There is no separate public permission setting.
- `publication` remains `PUBLISHED` if revision calculation, directory sync, or temporary cleanup fails after publication; an unconfirmed publish is `UNKNOWN`.
- POSIX directory synchronization is attempted after publication. Windows does not provide the same directory-sync path here, so this package does not claim crash-persistence guarantees there.

The default workspace path behavior is unchanged. Strict workspace jail remains an explicit future mode, not a default.

### Validation boundary

The standalone `0.1.0` candidate was typechecked against Pi `0.86.1` and passed the unit and bundled-ripgrep integration suites on GitHub-hosted Ubuntu, macOS, and Windows under Node 24. The same suites and an npm pack dry run passed locally on Windows `win32` with NTFS using Node `v26.9.0` and npm `11.19.1`; the tarball contains only the README, license, package metadata, and `src`. An installed-package loader smoke test was previously completed on Windows with Pi `0.85.1`. Network filesystems, full crash durability, Windows symlink permissions, and successful Windows atomic-read visibility remain unverified.

## Installation

```bash
pi install npm:@criogaid/pi-hashline-edit
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-hashline-edit"
  ]
}
```

## Dependencies

- No additional `@criogaid/pi-*` dependencies; peer `@earendil-works/pi-coding-agent` ships with pi (framework-level, not listed by convention).

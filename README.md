# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model cites lines from `read` or `grep`; `edit` checks those anchors against the current file before changing it. A rejected edit provides recovery information for the model to inspect and resubmit.

Overrides `read`, `grep`, `edit`, and `write`, adds `replace` for file-wide substitutions, and optionally adds `forget` to remove inspection results from model context. Mutations can include a follow-up command through [Action Fusion](#action-fusion).

[Quick start](#quick-start) · [Tools](#tools) · [Configuration](#configuration) · [Reports](#reports) · [Safety and design](#safety-and-design)

## Install

```bash
pi install npm:@criogaid/pi-hashline-edit
```

Requires Pi 0.99.1 or later. The extension works on local files. For remote or custom storage, set `hashlineEdit.enabled` to `false` and reload Pi to restore its built-in tools.

## Quick start

Pi's model uses these tools automatically. A `read` of `greet.ts` returns lines with `LINE#HASH` anchors:

```text
greet.ts · 3 lines
1#ZR63│export function greet() {
2#GFYR│  return "hello";
3#FNSZ│}
```

Copy an anchor into `edit` and supply the new line content:

```json
{
  "path": "greet.ts",
  "edits": [
    { "op": "replace", "anchor": "2#GFYR", "body": ["  return \"hello, hashline\";"] }
  ]
}
```

A successful mutation returns a JSON report; the TUI shows the diff. It does not return new anchors. Read or grep changed or shifted lines before editing them again. Existing anchors remain usable while their line number, full content, and hash-length setting are unchanged. Always copy actual tool output; the examples illustrate the default four-character hash.

## Tools

| Tool | Use it for |
| --- | --- |
| `read` | Inspect UTF-8 text with anchors; delegate supported images and NUL-containing files to Pi's built-in read, and reject other invalid UTF-8. |
| `grep` | Search files with JavaScript regex or literal text; return anchored matches, file paths, or counts. |
| `edit` | Replace, insert, delete, copy, or move whole lines using anchors. |
| `replace` | Apply literal or regex substitutions across one file. |
| `write` | Create a file or overwrite its complete contents. |
| `forget` | Remove eligible inspection results from model context when enabled. |

`read`, `edit`, `replace`, and `write` each take one `path`; `grep` can take several search roots. Paths accept relative and absolute names, `file://` URLs, leading `@`, and leading `~`. Windows forward-slash drive forms such as `/c/file`, `/mnt/c/file`, and `/cygdrive/c/file` resolve to native paths; mixed-separator forms do not. Supported Unicode spaces normalize as in Pi's built-in tools.

Grep returns paths that can be reused unchanged, preserving POSIX backslashes and escaping ambiguous names with `./` or encoded `file://` URLs. Unknown tool fields are rejected. All mutation tools share the same file queue and [publication rules](#publication).

### Read

Required: non-empty `path`. Optional: `offset` (1-based, default 1) and `limit` (default 500). Both must be positive safe integers.

The line limit and [byte budget](#output-budgets) bound output. When more content remains, `pagination` gives `start`, inclusive `end`, `totalLines`, and `nextOffset`; use that offset to continue. EOF results omit pagination. `truncatedAt` identifies a byte limit, and `lineTooLong` means the first requested row cannot fit. No partial editable rows are returned: reducing `limit` cannot split an oversized line.

### Grep

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pattern` | Required | Non-empty string or array of strings; arrays match any pattern (OR). |
| `path` | Current directory | Existing file or directory, or a non-empty array of roots. Wildcards belong in `glob`. |
| `glob` | None | Glob or ordered array of globs; prefix exclusions with `!`. |
| `literal` | Required | `true` for exact text, `false` for JavaScript regex. Literal mode still uses the case settings. |
| `flags` | `m` | Host JavaScript flags. Explicit flags replace the default; `g` is always enabled and duplicates are ignored. |
| `ignoreCase` | `i` or smart-case | `true` enables `i`, `false` removes it. Otherwise `i` wins; without it, any uppercase letter in the decoded query makes the search case-sensitive. |
| `multiline` | `false` | Allow matches across physical lines. `\n` then matches LF or CRLF. |
| `context` | `0` | Integer from 0 to 20; surrounding lines do not count toward `limit` or enable multiline matching. |
| `limit` | `100` | Positive safe-integer maximum of distinct matching physical lines, across files and patterns. |
| `outputMode` | `"content"` | Anchored rows and context; `"files"` returns paths, `"count"` returns per-file matching-line counts. |

JavaScript validates and executes every pattern. Invalid patterns or flags, including incompatible `u` and `v`, fail before searching. Scoped modifiers retain their local effect; if smart-case analysis reaches a parser limit, the default is case-sensitive. Grep does not accept the former `matchMode`, `excludePattern`, `wordMatch`, `pcre2`, `follow`, or `noIgnore` fields. Use lookaround and `\b` for pattern constraints.

Directory searches respect ignore rules, include hidden files except `.git`, and do not follow symlinks. Explicit paths can name ignored files, `.git`, or symlink targets; ordered glob filters still apply to named files. The tool uses bundled ripgrep and ignores external ripgrep configuration. Ripgrep selects candidates; JavaScript decides the matches. An empty result does not rule out matches in excluded files.

All modes use the same limited set of matching lines, rather than individual match objects. `matches` and `files` state the confirmed totals. Reaching `limit` sets `matchLimit` without proving that another match exists. File order follows search completion; with a limit, the selected files can vary between runs. A final newline does not add an empty row, and a zero-width EOF match belongs to the last line only when it has no final newline.

NUL-containing files are skipped. Other invalid UTF-8 is searched as lossy preview text and listed in `invalidUtf8`; its `LINE│content` rows have no editable anchors. Long lines show labeled partial previews, but their hashes cover the full line. Read the complete content before reconstructing one. Preview columns are 1-based UTF-16 positions.

Each matched file is tied to its byte revision. Files that change during searching or display are excluded with diagnostics; confirmed matches from other files remain available. Incomplete results set `details.incomplete` and carry `diagnostics`. If no results can be returned, the tool reports `SEARCH_INCOMPLETE` rather than an unqualified no-match result.

Broad queries may search whole candidate files. `candidates: "files"` means required literals narrowed the files; `"all"` means every file in scope was eligible. The latter stops queueing after [256 MiB](src/pi/grep-candidates.ts) and reports `scanLimit`. Narrow `path`, `glob`, or the pattern to continue. A physical line, or an entire file for multiline matching, may hold at most [64 MiB](src/pi/grep-search.ts); exceeding that limit produces an incomplete-search diagnostic. Isolated regex requests are bounded by `grep.regexTimeoutMs`.

### Edit operations

Required: `path` and a non-empty `edits` array. Anchors are `"LINE#HASH"` strings copied from inspection. Line numbers are positive safe integers without leading zeroes; hashes must use the configured `hashLen`. An optional `end` selects an inclusive range; omit it for one line. `end: null` is invalid.

| `op` | Required fields | Optional | Effect |
| --- | --- | --- | --- |
| `replace` | `anchor`, `body` | `end` | Replace a line or range. |
| `delete` | `anchor` | `end` | Remove a line or range. |
| `copy` / `move` | `anchor`, exactly one of `before` / `after` | `end` | Transfer original lines within the file; `move` also removes the source. |
| `insert_before` / `insert_after` | `anchor`, `body` | — | Insert beside the anchor, keeping that line. |
| `prepend` / `append` | `body` | — | Insert at the start or end. |

Each `body` element is one line without CR or LF. `body` must contain at least one element; `[""]` is a blank line. Use `delete` to remove lines, and do not repeat an insertion's anchor line in its body. `edit` accepts structured operations, not `oldText`/`newText` pairs or stringified JSON. Pi may convert a single operation object into an array during its own argument validation.

All operations use one original snapshot. Invalid anchors, ranges, or overlapping mutations reject the whole batch. Some touching edits also conflict; split them into calls and inspect any changed anchors between calls.

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "copy", "anchor": "10#ABCD", "end": "12#EFGH", "before": "30#JKMN" }
  ]
}
```

Copies and moves read original source text even if another operation changes that source. They preserve text and separators without adjusting indentation. Source reads may overlap mutations, but move deletions and destination insertions obey the usual conflict rules. Multiple insertions at one gap conflict. A move destination inside the source range is invalid; moving immediately before its first line or after its last is a no-op. Use body edits when the text needs to change.

On an anchor mismatch, recovery first searches within `shiftRadius`, then the rest of the file if no local candidate matches. Setting the radius to `0` disables both searches. A unique candidate includes its new anchor and bounded content; ambiguous candidates include up to eight anchors and merged ±3-line neighborhoods. With no candidate, the report shows the current cited row when available. A unique local match does not establish uniqueness across the whole file.

Recovery never edits or retries automatically. Confirm the intended target before resubmitting; read or grep when content is omitted. Every retry verifies its anchors again. In multi-operation failures, `matched` lists supplied anchors whose checksums passed, and `failures` lists mismatches. Omitted entries are counted, not implied successful. A matching checksum does not establish semantic intent or validate a range's interior.

### Bulk replacement

Required: `path` and a non-empty `replacements` array. Each rule requires non-empty `find` and a `replace` string, which may be empty:

```json
{ "path": "src/foo.ts", "replacements": [{ "find": "oldName", "replace": "newName" }] }
```

Literal mode is the default and keeps `$` text verbatim. Set `regex: true` for JavaScript captures and replacement templates:

```json
{ "path": "src/foo.ts", "replacements": [{ "find": "get([A-Z]\\w*)", "replace": "fetch$1", "regex": true }] }
```

Optional `flags` apply in either mode; accepted characters are `g i m s u y d`, with `g` always added. Unlike grep, replace has no default `m`: add it for per-line `^`/`$`. JavaScript `\d` is ASCII-only; `\w` and `\b` are ASCII-based, with Unicode case-folding exceptions under `iu`.

Rules match the original [LF view](#text-and-line-endings); inserted text is not searched again. For example, rules `foo` → `bar` and `bar` → `baz` turn original `foo bar` into `bar baz`. Captures and prefix/suffix substitutions also refer to the original snapshot.

Any invalid rule, unmatched rule (`NO_MATCH`), or overlapping matches (`OVERLAPPING_MATCHES`) rejects the entire batch before writing. Adjacent matches are allowed. Zero-length matches conflict at the same position or inside another match, including its start but not its end. Error rule indices and offsets are zero-based; offsets count UTF-16 units in the original text.

Regex batches run in a worker bounded by `replace.regexTimeoutMs`; cancellation or timeout leaves the file unchanged. A supplied `then_run` executes once after the whole batch succeeds. The full rule schema is in [`replace-schema.ts`](src/core/replace-schema.ts).

### Write

Required: `path`, `content`, and `mode`. `"create"` refuses an existing target; `"overwrite"` requires one. Missing or unknown modes fail before file access. Content is used exactly as supplied, including empty text and explicit line endings; anchor-looking prefixes are not stripped.

All mutation tools treat identical final bytes as a successful no-op: the target stays untouched and `publication` is `NOT_PUBLISHED`. Input, anchor, match, revision, target-type, and mode checks still apply. Creating a missing empty file is a publication, and create mode still rejects an existing file. A requested `then_run` can run after a no-op.

### Forget

Disabled by default; enable `hashlineEdit.forget` and reload Pi. Eligible read and content-mode grep results carry a `resultId` (`rXXXXX`): text of at least [2 KiB](src/pi/budgets.ts), or an image read. Smaller results, errors, and files/count grep output are not tagged.

A successful codemode result containing a successful read or content-mode grep call uses the same threshold. Its single tag covers the entire script output, including transformed data and other printed results; `forgetScope` states that scope. Nested calls have no separate tags. Use separate scripts when results need independent forgetting decisions.

Call `forget` with a non-empty array of distinct `ids` and, if needed, a non-empty `note` containing conclusions to retain. Only results of the previous response qualify. The model forgets unneeded results in one call alongside its other tool calls, and skips forgetting when it makes no other call. It may forget an inspection result in the same response that submits its anchors to edit. Later responses cannot forget that result.

Ids that no longer qualify appear in `notForgettable` without blocking valid ids; when none qualify, the call fails with `NOT_FORGETTABLE`. After the calling response completes, Pi replaces each selected result's entire content with a receipt containing `contentForgotten: true`. Keep needed facts in `note`; rerun the original call to see its output again.

Files, raw session history, tool calls, notes, and the TUI remain unchanged. Navigating before the context edit restores the original result. The forget card shows a description of each removed result and adds its id when expanded. Disabling forget prevents new tags and context hooks but does not undo stored edits. This feature changes request contents; provider cache savings are not measured.

## Configuration

Add `hashlineEdit` to Pi's global settings (`~/.pi/agent/settings.json` by default) or the project's `.pi/settings.json`:

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "forget": false,
    "hashLen": 4,
    "shiftRadius": 15,
    "read": { "defaultLimit": 500 },
    "grep": { "defaultLimit": 100, "defaultContext": 0, "regexTimeoutMs": 5000 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the extension's tools and hooks. |
| `actionFusion` | `true` | Expose `then_run` on mutation tools. |
| `forget` | `false` | Register forget and tag eligible results. |
| `hashLen` | `4` | Checksum length, integer 2–8. Re-read anchors after changing it. |
| `shiftRadius` | `15` | Initial recovery radius, integer 0–100 lines; `0` disables recovery searches. |
| `read.defaultLimit` | `500` | Default returned lines; positive safe integer. |
| `read.maxKiB` | Model capacity | Explicit anchored-text cap, 1–4096 KiB. Calls cannot raise it; omit for automatic sizing. |
| `grep.defaultLimit` | `100` | Default matching lines; positive safe integer. |
| `grep.defaultContext` | `0` | Default context, integer 0–20. |
| `grep.regexTimeoutMs` | `5000` | One regex request, integer 3000–300000 ms, including remaining worker startup. |
| `replace.regexTimeoutMs` | `5000` | One regex batch, integer 3000–300000 ms, including worker startup. |

The project's `hashlineEdit` object replaces the global object as a whole. Within it, missing or invalid settings use their defaults while valid neighbors are kept. Invalid `read.maxKiB` selects automatic sizing. The [configuration schema](src/pi/config.ts) defines all types, bounds, and defaults. Reload Pi after changes; registered tools keep their configuration until then.

## Action Fusion

Enabled by default. `edit`, `replace`, and `write` accept an optional command to run after the mutation:

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

`command` must contain a non-whitespace character. Optional `timeout` is in seconds, greater than zero and at most 2147483.647, with no default. Unknown fields are rejected before the file is touched. Set `hashlineEdit.actionFusion` to `false` and reload to remove command support.

After a successful mutation, Fusion checks that the file still matches the published revision, then invokes the session's callable Bash tool. Bash overrides, approval hooks, argument validation, and result hooks apply. An unavailable or blocked Bash tool produces a command failure. Mutation failure or a changed target prevents the command from starting.

Command failure never rolls back the file or turns a completed mutation into a mutation failure. The report carries `then_run.status` (`succeeded`, `failed`, `timeout`, `cancelled`, or `skipped`) and Bash output. A final freshness check reports a changed, missing, or unreadable target and asks for a re-read. The final session result determines command status; a nested `terminate` hint passes to the parent tool result.

The per-file Fusion queue covers the mutation and command, so another fused call on that file waits. The tool call also waits for command completion and the final freshness check before model continuation. Local queues do not prevent external processes from changing the file.

The TUI shows separate mutation and command cards. The diff remains visible while the command runs; skipped or cancelled commands show their reason. With `timeout`, a countdown starts at Bash's first execution update, excluding queue and approval waits. Bash enforces the timeout; an override without progress updates has no live countdown. Saved unfinished commands restore as interrupted with an unknown outcome. RPC hosts receive progress and choose their own presentation.

## Reports

Tool facts are returned as one JSON report. Successful reads and searches append it after their payload; mutations return it alone. Success text omits `tool` and `path`, which the call already supplies, while `details.report` retains them for display. A report with no outcome facts is omitted when there is a payload. Failures return the report as the entire error result.

Failure reports name the `error`, failing step in `message`, and any underlying `cause`. Mutation failures also state `publication` and `stage` (`prepare`, `commit`, or `post_process`). Tool-specific facts describe pagination, search completeness, replacement counts, or recovery candidates. The optional final `next` field gives the recovery instruction. Follow it before retrying, especially when a write may already have been published.

For example, a successful mutation followed by a failed command returns:

```json
{
  "publication": "PUBLISHED",
  "then_run": { "status": "failed", "output": "…Bash output…\n\nCommand exited with code 1" }
}
```

[`report-schema.ts`](src/pi/report-schema.ts) defines every field, error code, and recovery rule. Each fact has one owner and appears once; native failures retain their diagnostic rather than repeating it in a wrapper. Reports reject unknown fields and require the facts for their code. Old saved formats are not kept compatible. Invalid text-only reports remain raw, and invalid saved Fusion cards are ignored.

### Argument errors

`INVALID_ARGUMENTS` means execution did not start. Its `issues` name each field, explain the `reason`, and include a `fix` when needed; shared fixes appear once. Diagnostics collect independent errors, select the relevant operation shape, and avoid duplicate parent summaries. A copy/move with neither or both destinations gets one exactly-one issue. Pi's schema pipeline still controls coercion and acceptance.

Field paths use dots for named properties, `[0]` for array indices, and JSON-quoted brackets for other names. `$` denotes a preparation failure without a field diagnostic. `omittedIssues` counts issues excluded by the byte budget; `schemaLimited` means a native diagnostic allowance was reached. These notices remain visible in collapsed cards. Expanding shows all retained issues without repeating the call's arguments.

## Safety and design

Anchors are short checksums of a line's number and content. They can collide and do not prove the model observed the line. A range checks its supplied endpoints, not every interior line. Unrelated changes can leave anchors valid; line shifts usually invalidate them.

### Text and line endings

`read`, `grep`, `edit`, and `replace` share an LF view: CRLF becomes LF, while standalone CR and literal source escapes remain content. Thus an actual CRLF in literal `find` matches a line boundary, but JSON `"find": "\\r\\n"` matches the four visible characters. Standalone CR displays as `␍`; that marker is a display aid, not replacement text.

Edit and replace map changes back to original bytes. They reuse matched separators in order, repeat the last for extra gaps, or use the file style (CRLF if present, otherwise LF). Untouched boundaries remain unchanged. Write uses supplied line endings exactly; use it for intentional whole-file conversion, and a raw byte reader to distinguish LF from CRLF.

For edit, a non-empty final line retains the original final-newline state. A final blank line gets the terminator needed to represent it: appending `[""]` to `"a"` produces `"a\n\n"`. A BOM-only file already represents one blank line and keeps its BOM. Edit preserves an existing UTF-8 BOM at byte zero, including through copies, moves, and deletion of all content. Copy/move excludes that header from captured text; interior `U+FEFF` remains content. Replace can explicitly match the BOM; write uses supplied content.

Mutations reject NUL and text that cannot be encoded losslessly as UTF-8. Edit and replace also reject invalid UTF-8 source files. UTF-16 and legacy code pages are not supported. Only confirmed malformed UTF-8 is classified as `UNSUPPORTED_ENCODING`; decoder resource failures keep their original error.

Reads check file identity, size, and timestamps before accepting content. Detected concurrent writes, replacement, truncation, or deletion produce `FILE_CHANGED`; grep omits that file with diagnostics. These checks are not atomic snapshots and cannot detect changes hidden by timestamp resolution. Grep and mutations also retain byte-revision checks.

### Publication

All mutations use the [shared commit layer](src/pi/file-commit.ts). Edit and replace bind publication to the revision of the bytes they read. Complete content is written and synced in a sibling temporary directory, then published with a link for creation or a rename for overwrite; the old target is never deleted first.

| State | Meaning |
| --- | --- |
| `NOT_PUBLISHED` | No file change was published, including a successful no-op. |
| `PUBLISHED` | The file was published, even if a later step failed. |
| `UNKNOWN` | Publication could not be confirmed; inspect the file before retrying. |

Overwrites resolve symlinks and preserve the link; unresolved links, non-regular files (including FIFOs), and multiple hard links are rejected. Existing mode bits are copied; new files use `0600`. Directory sync is attempted on POSIX, tolerating unsupported-operation errors; Windows skips it.

Post-publication failures retain the publication state and any completed command outcome. A `PUBLISHED` or `UNKNOWN` failure tells the model to read before repeating the change. Successful results expose `details.publishedRevision`; later observations that cannot confirm it add `freshness` (`changed`, `missing`, or `unknown`), with `freshnessError` for a failed observation.

Revision checks and local queues do not create a cross-process transaction: an external writer can race a check and publication. There is no strict workspace jail or multi-file transaction.

### Output budgets

Budgets use the selected model's declared `contextWindow`, not remaining context or output `maxTokens`. They limit individual outputs, not the whole conversation or a combined codemode result. [`budgets.ts`](src/pi/budgets.ts) defines the policy; [`model-budgets.ts`](src/pi/model-budgets.ts) refreshes it when the selected model or capacity changes. Each call keeps one budget snapshot.

For a valid capacity `N`:

| Allowance | Calculation |
| --- | --- |
| Content (`B`) | One byte per context token, capped at 4096 KiB |
| Diagnostic block (`D`) | `max(512, floor(B / 4))` bytes |
| Text field / candidate row (`F`) | `max(128, floor(D / 4))` bytes |
| Grep preview (`P`) | `floor(F / 4)` UTF-16 units, excluding labels |

Unknown capacity uses read 256 KiB, grep 50 KiB, diagnostic blocks 16 KiB, fields 4 KiB, and previews of 500 units. An explicit `read.maxKiB` changes only read's content cap.

Read returns whole anchored rows within `B`; grep uses `B` for payload and `P` for each long-line preview. Report and cause messages, argument reasons/fixes, and grep diagnostics use `F`, retaining opening and ending text with omission notices. Argument reports stay valid JSON within `D` and omit whole issues when needed.

Anchor failures, matched-anchor lists, and candidate neighborhoods each have an independent `D` allowance. Candidate content uses `F`; neighborhoods retain complete anchored rows in line order. Omitted items are counted. These independent allowances mean a report can exceed `D` overall; `next` is outside the budgets. Images, delegated reads, Bash output, process buffers, and collapsed TUI previews retain their own limits. Expanding a TUI card does not change the model's result.

## Verification

| Command | Checks |
| --- | --- |
| `npm run format:check` | Formatting in `src/` and `bench/`. |
| `npm run typecheck` | Source, test, and benchmark types. |
| `npm test` | Core and tool tests. |
| `npm run test:integration` | Bundled ripgrep, large files, platform file types, installed packages, and real Pi session behavior. |
| `npm run test:all` | Unit and integration suites. |
| `npm run test:cartesian` | Only the Cartesian regex matrices from both suites. |
| `npm run bench` | Core throughput and long-line match mapping. |
| `node --expose-gc bench/grep-memory.bench.ts` | Grep latency and sampled peak heap/RSS on temporary fixtures. |

Cartesian matrices take minutes each and are skipped by the ordinary suites and CI. Run them after changing regex translation, candidate derivation, or prefiltering.

Tests run with isolated Node options and temporary Pi settings. Session tests use local scripted responses, never provider requests. Installed-package tests cannot resolve checkout development dependencies; the npm archive test checks tool registration, regex workers, commands, and forgetting through Pi's loader. It requires npm and tar.

Module responsibilities are documented in [`src/core/AGENTS.md`](src/core/AGENTS.md) and [`src/pi/AGENTS.md`](src/pi/AGENTS.md). [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) records the sources and licenses of borrowed regex analysis techniques and test cases.

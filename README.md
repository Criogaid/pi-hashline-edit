# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model references lines it has read and supplies their new content; the tool checks each anchor against the current file before editing.

Overrides `read`, `grep`, `edit`, and `write`, and adds `replace` for bulk transformations.

- **Search → edit:** `read` and `grep` return the same `LINE#HASH` anchors, so search results can feed directly into edits.
- **Batch and chain edits:** submit structured JSON operations together, then use the returned fresh anchors for the next change.
- **Recover from stale anchors:** rejected edits show a unique checksum-matching candidate's line, or neighborhoods around ambiguous candidates for comparison. With no candidate, they ask the model to re-read the file. Recovery never applies automatically.
- **Edit → test:** Action Fusion lets a mutation include an optional follow-up command, with separate file and command outcomes and separate TUI cards.

[Quick start](#quick-start) · [Tools](#tools) · [Configuration](#configuration) · [Action Fusion](#action-fusion) · [Safety and design](#safety-and-design)

## Install

```bash
pi install npm:@criogaid/pi-hashline-edit
```

This extension works on **local files**. For remote/custom-storage operations, disable it in [configuration](#configuration) and reload Pi to use the built-in tools.

## Quick start

Once installed, Pi's model uses these tool calls automatically. The examples below show the read → edit protocol.

A `read` of `greet.ts` returns:

```text
greet.ts · 3 lines
1#ZR63│export function greet() {
2#GFYR│  return "hello";
3#FNSZ│}
```

To change the return value, copy the second line's anchor into `edit` and supply only the new content:

```json
{
  "path": "greet.ts",
  "edits": [
    { "op": "replace", "anchor": "2#GFYR", "body": ["  return \"hello, hashline\";"] }
  ]
}
```

The result includes a diff and the updated anchor:

```text
Updated anchors:
2#V8AT
```

Use returned anchors for changed lines in subsequent edits. Previously observed anchors remain usable when their line number, full content, and hash-length configuration are unchanged. Content-mode `grep` provides the same references, grouped by file. Always copy actual tool output; the examples use the default four-character hash.

Successful `edit` and `replace` results omit candidate rows whose full content at the same line number is unchanged, then return compact `LINE#HASH` tokens by default. `edit` retains complete content for a deletion successor unless the batch also supplies that row; `replace` retains it for the first surviving line after a pure deletion. Anchor reports have a 16 KiB byte limit, including heading/omission notice, with no fixed entry-count limit. Neither tool reports every shifted line in the remaining file; read shifted positions when needed and no fresh anchor was returned. `write` returns no anchors. Explicit `read`/`grep` results and edit failure context continue to include the requested or diagnostic rows.

## Tools

| Tool | Use it for |
| --- | --- |
| `read` | Inspect files with line anchors; images/binary handling delegates to Pi. |
| `grep` | Search with bundled ripgrep and return anchored matches/context, file paths, or counts. |
| `edit` | Change specific lines or ranges using verified anchors. |
| `replace` | Replace every occurrence of a literal string or JavaScript regex across one file. |
| `write` | Create a file or replace its complete contents. |

All tools accept relative and absolute paths, `file://` URLs, a leading `@` prefix, and a leading `~` (including `~\` on Windows). As in Pi's built-in file tools, supported Unicode spaces in paths become regular spaces, and Windows shell drive paths such as `/c/file`, `/mnt/c/file`, and `/cygdrive/c/file` resolve to native drive paths. Mutation tools share the file-mutation queue and commit layer.

### Edit operations

`edit` takes `path` and an `edits` array. Anchors are `"LINE#HASH"` strings; each `body` element is one logical line without CR or LF.

| `op` | Required | Optional | Effect |
| --- | --- | --- | --- |
| `replace` | `anchor`, `body` | `end` | Replace one line or an inclusive range. |
| `delete` | `anchor` | `end` | Delete one line or an inclusive range; no `body`. |
| `insert_before` / `insert_after` | `anchor`, `body` | — | Insert beside the anchor; keep the anchor line. |
| `prepend` / `append` | `body` | — | Insert at the start/end; no anchors. |

All operations in a batch use the same snapshot. Validation failure rejects the whole batch. Conflicting fields and overlapping operations are rejected; some touching operations also conflict and need separate calls with fresh anchors. For insertion, **do not repeat the anchor line in `body`**. `edit` uses structured operations, not `oldText`/`newText` pairs.

Rejected batches report each supplied anchor's status from that validation snapshot: `matched`, `mismatched`, or `not_checked` when body validation stopped the batch before hashing. Entries identify the zero-based operation index, `anchor` or `end`, and the cited token. The bounded list reports omitted entries explicitly. These statuses do not establish range/overlap validity, semantic intent, publication, command success, or validity on a later retry.

Recovery first searches within `shiftRadius` of the cited line. If that search finds no candidates, it searches the rest of the file and collects all checksum matches before deciding whether the result is unique or ambiguous. Existing local candidates take priority; distant matches are not added when local candidates exist. `shiftRadius: 0` disables both searches. Candidate matching holds the original line number fixed when hashing current content; returned anchors use each candidate's actual line number.

Candidate diagnostics identify the search as `Search: local` or `Search: full file`. Local results explicitly state that matches outside the window were not checked: a unique local candidate does not establish uniqueness across the file. The cited line and returned candidate anchor show the old and current positions.

A unique recovery candidate returns its new anchor and complete line content, without a neighborhood. Content is shown once per line and is limited to 4 KiB per candidate row; oversized content is omitted in full with a prompt to use `read` or `grep`.

Ambiguous failures list up to eight candidate anchors and include a bounded ±3-line neighborhood around each listed candidate from the same snapshot. Windows are clipped to file boundaries, merged, and emitted in ascending line order within byte budgets. Neighboring rows are observations, not recommended replacement targets. Candidate content already present in a neighborhood is not repeated in failure details. Inspect the code to choose the correct anchor and operation, then resubmit. No edit or retry is performed automatically, and every submitted anchor is verified again.

When no candidate is found, diagnostics ask the caller to use `read` to inspect the current file before retrying and include no context rows for that failure. Input-anchor checks still report the cited tokens and their validation status.

### Bulk replacement

For a rename across a file:

```json
{ "path": "src/foo.ts", "find": "oldName", "replace": "newName" }
```

Literal mode inserts replacement text verbatim. Set `regex: true` for JavaScript capture groups and replacement templates:

```json
{ "path": "src/foo.ts", "find": "get([A-Z]\\w*)", "replace": "fetch$1", "regex": true }
```

To apply several rules against the same original content:

```json
{
  "path": "src/foo.ts",
  "replacements": [
    { "find": "foo", "replace": "bar" },
    { "find": "bar", "replace": "baz" }
  ]
}
```

Original `foo bar` becomes `bar baz`; inserted text is not searched again. All rules must succeed before one file commit. `then_run`, when supplied, runs once after the entire batch succeeds.

<details>
<summary><strong>Full read, grep, replace, and write parameter reference</strong></summary>

### Read

Required: `path`. Optional: 1-based `offset` (default 1) and `limit` (default 2000 lines). Returned text is capped at 256 KiB; oversized rows are not returned as partial editable lines. Files without a final newline are identified in the header.

### Grep

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pattern` | Required | Non-empty string or array. |
| `path` | Current directory | One path or an array of search roots. |
| `matchMode` | `"any"` | OR across patterns; `"all"` requires every pattern on the same physical line, at most 16 patterns. |
| `excludePattern` | None | String or array; remove lines matching any exclusion. |
| `literal` | Automatic | `true`: literal strings. `false`: strict regex. Automatic mode detects regex metacharacters; parse failures fall back to literal text only for one inclusion pattern without exclusions. Invalid compound queries fail with guidance to fix the regex or explicitly set `literal: true`. |
| `ignoreCase` | Smart-case | Explicit `true`/`false` overrides case handling; the query-level decision also applies to exclusions. |
| `wordMatch` | `false` | Whole-word matches. |
| `glob` | None | One glob or an ordered array; prefix exclusions with `!`. |
| `noIgnore` | `false` | Include ignored files; explicit globs still apply. |
| `follow` | `false` | Traverse symlinks and return resolved target paths. |
| `context` | `0` | Include 0–20 anchored lines before and after matches. |
| `limit` | `100` | Maximum matching physical lines, counted after filtering. |
| `outputMode` | `"content"` | `"files"` returns paths; `"count"` returns per-file counts and a total. Both use the same limited match set. |
| `pcre2` | `false` | Enable PCRE2 lookarounds/backreferences; strict regex, incompatible with `literal: true`. |
| `multiline` | `false` | Allow cross-line matches; `.` crosses newlines only with inline `(?s)`. |

Context is rebuilt from surviving matches. Multiline filtering, counting, and limits remain line-based. Wildcard-only regexes such as `.*` and `^.+$` are accepted; use `literal: true` to search those characters verbatim.

All inclusion/exclusion matching uses bundled ripgrep, independent of system `rg` or `PATH`. Searches are CRLF-aware, include hidden files while respecting ignore rules, and pass `--no-config`. The default engine is Rust regex; PCRE2 never silently falls back to another engine or literal matching.

Search diagnostics are preserved even when a result limit stops ripgrep. Readable, confirmed matches remain available with a `Search incomplete` notice and `details.incomplete: true`; counts then cover only confirmed matches. If no results can be returned, the tool reports an error rather than claiming there are no matches. Exclusion-scan failures still reject the query, because incomplete exclusions could admit incorrect results. Search diagnostics have a separate 4 KiB display budget.

Long lines show a labeled partial preview of up to 500 UTF-16 units around a ripgrep match; context-only lines show their beginning. Labels report 1-based UTF-16 column ranges, and slicing preserves surrogate pairs. The anchor hashes the entire current line, not the preview; use `read` before reconstructing a line from its content.

### Replace

Required: `path` and either top-level `find` / `replace`, or a non-empty `replacements` array. These forms are mutually exclusive: batch calls cannot include top-level `find`, `replace`, `regex`, `flags`, or `maxMatches`. Each rule requires `find` and `replace`, with these optional fields:

- `regex`: defaults to `false`; regex mode supports capture groups, the full match, and prefix/suffix substitutions.
- `flags`: applies in both modes; `g` is always added. Supported flags: `g i m s u y d`.
- `maxMatches`: defaults to 2000 per rule and must be finite and positive; rejects excess matches before writing. Raise it for intentional bulk changes. It does not bound regex execution time or result size.

Zero matches in any rule, an invalid rule, or overlapping match ranges rejects the whole call without writing. Adjacent ranges are allowed. Zero-length matches conflict at the same position or at the start/interior of another match; a zero-length match at another match's end is allowed unless it conflicts with a following match. Error rule indices and string offsets are zero-based (offsets count UTF-16 code units).

Regex captures and prefix/suffix substitutions always refer to the original snapshot.

### Write

Required: `path`, `content`. By default, create missing files and overwrite existing ones. Content is used exactly as supplied; anchor-looking prefixes are not stripped.

- `mode: "create"`: refuse an existing target.
- `mode: "overwrite"`: require an existing target.
- `expectedRevision`: strictly check the current file's SHA-256; cannot be combined with create mode.

Write results report the write outcome without returning line anchors. Use `read` or content-mode `grep` to obtain anchors for a later `edit`.

Normal write result text omits the revision. Programmatic callers can read `details.publishedRevision`; text-only callers needing `expectedRevision` must obtain a SHA-256 of the file bytes separately. Revision checks and structured revision fields remain active.

With Action Fusion enabled, `edit`, `replace`, and `write` also accept `then_run`.

All three mutation tools treat identical final content as a successful no-op: report `no net change`, leave the existing file untouched, and return `publication: "NOT_PUBLISHED"`. A requested `then_run` still runs after freshness checks. Input, anchor, match, target-type, mode, revision, and cancellation checks still apply; zero matches, stale anchors/revisions, and an existing target in create mode remain errors. Creating a missing empty file is a publication, not a no-op.

</details>

## Configuration

Add `hashlineEdit` to Pi's global settings (`~/.pi/agent/settings.json` by default) or the project's `.pi/settings.json`:

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "hashLen": 4,
    "shiftRadius": 15
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable all five tools as one unit. Set `false` to restore built-in tools. |
| `actionFusion` | `true` | Expose `then_run` on mutation tools. Set `false` to disable command support. |
| `hashLen` | `4` | Integer checksum length, 2–8 characters. |
| `shiftRadius` | `15` | Integer first-pass recovery-search radius, 0–100 lines. With no local candidates, recovery searches the rest of the file; `0` disables both searches. |

The project's `hashlineEdit` object replaces the global object as a whole; missing or invalid fields use defaults. Reload Pi after changes.

## Action Fusion

Action Fusion is enabled by default. Set `"actionFusion": false` in `hashlineEdit` and reload Pi to disable it; an existing explicit `false` remains effective. Commands run only when a call supplies `then_run`:

```json
{
  "path": "src/foo.ts",
  "find": "oldName",
  "replace": "newName",
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

`command` is required; `timeout` is optional, in positive seconds, with no default. Mutation failure skips the command. Command failure after mutation success **does not roll back the file**: it is returned separately in result text and `details.actionFusion`, rather than thrown as failure of the whole mutation.

In the TUI, the mutation card owns the mutation's result or error summary, publication status, and freshness warnings. It turns successful when mutation execution and result generation finish. The command card owns command output and execution status; skipped or cancelled commands are neutral and show a short reason when execution never started. Mutation diagnostics never become command output, and command failure leaves a successful mutation card intact. RPC hosts receive the same progress and choose their own rendering.

Fusion serializes each mutation/command sequence for its target and checks the published revision before running the command. Commands invoke Pi's built-in Bash definition directly, without a separate Bash tool call; Bash-only approval/sandbox extensions must explicitly cover these tools' `then_run` inputs.

## Safety and design

- **Anchors are checksums, not identities.** Each hash combines the 1-based line number and content. Short hashes can collide and do not prove the model observed a line.
- **Validation is local to supplied anchors.** Unrelated in-place changes leave stable anchors usable. A range verifies its supplied start/end anchors, not every interior line.
- **Line shifts change anchors.** Insertions/deletions can invalidate later references. Recovery searches within `shiftRadius`, then the rest of the file if no local candidates match. Unique candidates include bounded line content; ambiguous candidates include neighborhoods for comparison. Use `read` when no candidate is found or needed content is omitted. Retries verify again, without fuzzy matching or automatic relocation.
- **Edits preserve text representation.** `edit` preserves existing line endings, untouched separators, and the absence of a final newline. `edit`/`replace` reject invalid UTF-8 source text; all mutations reject NUL and output that cannot be encoded losslessly as UTF-8.
- **Fresh anchors depend on the final observation.** After `then_run`, anchors are shown only for `unchanged` freshness. Without a command, observed and published revisions must agree. Later edits still verify anchors.
- **Local queues are not cross-process transactions.** Revision checks bind mutations to the bytes read, but an external writer can still race a check and publication. There is no strict workspace jail or multi-file transaction.

<details>
<summary><strong>Output budgets, byte fidelity, publication, and result-state details</strong></summary>

### Hashing and BOM handling

`read` computes line hashes only for its requested window; `grep` hashes selected matches/context. Both still read and decode whole files. Mutation revision checks cover actual bytes.

Line boundaries are LF or CRLF; a standalone CR remains line content. Anchored rows display standalone CR as `␍` (U+240D), while hashes use the original content. Edit/replace diff previews also show CR as `␍`, including CR in CRLF endings; their unified patches retain the original characters and line endings. The marker is a display aid, not replacement text.

An existing UTF-8 BOM stays at byte zero through first-line replacement/deletion or insertion; deleting all content leaves the BOM. First-line hashes include it. A copied leading BOM in the first replacement/insertion line denotes the existing header; interior `U+FEFF` remains content. BOM-only files retain one anchored line. `replace` can explicitly match the BOM; `write` uses supplied content.

### Output budgets

These limits bound model context, not file size. Omission notices direct the caller to read more.

| Output | Limit |
| --- | --- |
| `read` | Default 2000 rows, overridable with `limit`; 256 KiB of anchored text. No partial anchor rows. An oversized single row directs the caller to inspect chunks with `bash` or make a known text change with `replace`; reducing `limit` cannot split a physical line. |
| `grep` | Default 100 matching lines, overridable; up to 500 UTF-16 units per partial line preview, plus labels and Pi's total output limits. Match previews use rg byte offsets; hashes use full content. Search error notices have a separate 4 KiB budget. |
| `edit` / `replace` anchors | 16 KiB including heading/omission notice, with no fixed entry-count limit. Compact tokens for changed positions; selected deletion successors retain complete content. Rows that do not fit are omitted in full; later rows that fit are still returned. |
| Anchor failure details | 16 KiB, with no fixed failure-count limit; unique candidates include complete rows up to 4 KiB, and ambiguous failures list up to eight candidates each. Unresolved anchors request a fresh read without context rows. |
| Input-anchor checks | Independent 16 KiB block, with no fixed entry-count limit. Truncation is reported explicitly; omitted entries are not implied matched. |
| Ambiguous-candidate neighborhoods | 16 KiB of complete anchored row text, lowest-line first, plus headings; no fixed row-count limit. Uses the same first eight candidates per failure as the detail lists. Each listed candidate row is limited to 4 KiB. Rows exceeding either limit are omitted in full; later rows that fit are still returned, with gaps reflected in the neighborhood headings. |

The diagnostic blocks have independent budgets; their combined output can exceed 16 KiB. Truncation notices identify exhausted budgets; context windows also report shown/omitted row counts. Limits apply to rendered diagnostics; core failure results retain all input-anchor checks.

### Publication

The shared commit layer validates the target and skips publication when the requested UTF-8 bytes have the current file's SHA-256. Otherwise, it prepares and syncs complete content in a sibling temporary directory. `edit`/`replace` bind this check and publication to the revision of the bytes they read.

| Case | Behavior |
| --- | --- |
| No-op | After validation, return existing revisions without creating a temporary file or replacing the target. |
| Create | Same-filesystem `link(temp, target)` refuses a target created by another writer during publication. |
| Overwrite | `rename(temp, target)` publishes the replacement; never delete the old target first. |
| Symlinks | Resolve the regular-file target for overwrite and preserve the link; reject dangling/unresolvable links. |
| Multiple hard links | Reject existing regular files with multiple links to avoid splitting the link set. |
| Permissions | Copy existing mode bits; new files use `0600`. No separate public permission setting. |
| Post-publication failure | Directory-sync, result-generation, revision observation, or cleanup errors retain `PUBLISHED`; unconfirmed publication is `UNKNOWN`. Read before retrying uncertain mutations. |
| Durability | Attempt POSIX directory synchronization. Windows has no equivalent directory-sync path here; no Windows crash-persistence guarantee is claimed. |

### Result and card states

| Field | Meaning |
| --- | --- |
| `publication` | `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`. Fusion also reports it in `actionFusion.publication`. |
| `baseRevision` | SHA-256 of bytes read before mutation, when available. |
| `publishedRevision` | SHA-256 of intended published bytes; `revision` is its compatibility alias. |
| `observedRevision` | SHA-256 observed by the commit layer after publication, or at the no-op check. |
| `actionFusion.command` | `not_requested`, `skipped`, `succeeded`, `failed`, `timeout`, or `cancelled`. |
| `actionFusion.freshness` | `unchanged`, `changed`, `missing`, or `unknown`, relative to the published revision. |
| `actionFusion.mutationCompleted` | Progress flag set after mutation execution and result generation succeed; publication alone is not mutation success. |

Streaming mutation summaries omit anchors. Result-generation failures preserve publication status and any completed command outcome; progress callback failures are reported separately from mutation/command outcomes. Command progress `output` contains only command output or execution errors, with an optional `reason` for commands that never started. Command cards persist only their own state and use native Bash output rendering. Final cards survive reloads without adding model-context messages; unfinished saved commands show an interrupted/unknown outcome. Older mixed failure snapshots expose only recognized command diagnostics, leaving other details in the original tool result.

</details>

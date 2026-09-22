# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model references lines it has read and supplies their new content; the tool checks each anchor against the current file before editing.

Overrides `read`, `grep`, `edit`, and `write`, and adds `replace` for bulk transformations.

- **Search → edit:** `read` and `grep` return the same `LINE#HASH` anchors, so search results can feed directly into edits.
- **Batch and chain edits:** submit structured JSON operations together, then use the returned fresh anchors for the next change.
- **Recover from stale anchors:** rejected edits show bounded content for a unique checksum-matching candidate, or nearby current-file context when no candidate is found, so the model can verify the target before retrying. Recovery never applies automatically.
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

Use returned anchors for subsequent edits. Content-mode `grep` provides the same references, grouped by file. Always copy actual tool output; the examples use the default four-character hash.

Successful `edit` results return compact tokens for inserted or replaced lines. A line exposed by deletion retains its content as `LINE#HASH│content`, unless the same batch also supplies that line. `replace` results retain anchored content for the changed region.

## Tools

| Tool | Use it for |
| --- | --- |
| `read` | Inspect files with line anchors; images/binary handling delegates to Pi. |
| `grep` | Search with bundled ripgrep and return anchored matches/context, file paths, or counts. |
| `edit` | Change specific lines or ranges using verified anchors. |
| `replace` | Replace every occurrence of a literal string or JavaScript regex across one file. |
| `write` | Create a file or replace its complete contents. |

All tools accept relative or absolute paths and expand a leading `~`. Mutation tools share the file-mutation queue and commit layer.

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

A unique recovery candidate includes a bounded ±3-line neighborhood from the same snapshot. Candidate content is shown once in that neighborhood; if the neighborhood omits it, a complete candidate row can appear in the failure details within their output limits. Overlapping neighborhoods are merged; neighboring rows are observations, not recommended replacement targets. Inspect the code to choose the correct anchor and operation, then resubmit. No edit or retry is performed automatically, and every submitted anchor is verified again.

### Bulk replacement

For a rename across a file:

```json
{ "path": "src/foo.ts", "find": "oldName", "replace": "newName" }
```

Literal mode inserts replacement text verbatim. Set `regex: true` for JavaScript capture groups and replacement templates:

```json
{ "path": "src/foo.ts", "find": "get([A-Z]\\w*)", "replace": "fetch$1", "regex": true }
```

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
| `literal` | Automatic | `true`: literal strings. `false`: strict regex. Automatic mode detects regex metacharacters and falls back to literal text for all patterns on regex parse failure. |
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

### Replace

Required: `path`, `find`, `replace`. Optional:

- `regex`: defaults to `false`; regex mode supports capture groups, the full match, and prefix/suffix substitutions.
- `flags`: applies in both modes; `g` is always added. Supported flags: `g i m s u y d`.
- `maxMatches`: defaults to 2000; rejects excess matches before writing. Raise it for intentional bulk changes. It does not bound regex execution time or result size.

Zero matches is an error. Identical output reports no net change.

### Write

Required: `path`, `content`. By default, create missing files and overwrite existing ones. Content is used exactly as supplied; anchor-looking prefixes are not stripped.

- `mode: "create"`: refuse an existing target.
- `mode: "overwrite"`: require an existing target.
- `expectedRevision`: strictly check the current file's SHA-256; cannot be combined with create mode.

Write results report the write outcome without returning line anchors. Use `read` or content-mode `grep` to obtain anchors for a later `edit`.

Normal write result text omits the revision. Programmatic callers can read `details.publishedRevision`; text-only callers needing `expectedRevision` must obtain a SHA-256 of the file bytes separately. Revision checks and structured revision fields remain active.

With Action Fusion enabled, `edit`, `replace`, and `write` also accept `then_run`.

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
| `shiftRadius` | `15` | Integer recovery-search radius, 0–100 lines; `0` disables recovery. |

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

In the TUI, the mutation card turns successful when execution and result generation finish. The command gets its own waiting/running/success/failure card with expandable output. Command failure leaves the successful mutation card intact. RPC hosts receive the same progress and choose their own rendering.

Fusion serializes each mutation/command sequence for its target and checks the published revision before running the command. Commands invoke Pi's built-in Bash definition directly, without a separate Bash tool call; Bash-only approval/sandbox extensions must explicitly cover these tools' `then_run` inputs.

## Safety and design

- **Anchors are checksums, not identities.** Each hash combines the 1-based line number and content. Short hashes can collide and do not prove the model observed a line.
- **Validation is local to supplied anchors.** Unrelated in-place changes leave stable anchors usable. A range verifies its supplied start/end anchors, not every interior line.
- **Line shifts change anchors.** Insertions/deletions can invalidate later references. Recovery searches within `shiftRadius`; a unique candidate includes bounded line content and neighboring code for inspection. Use `read` when the target or needed context is omitted or ambiguous. Retries verify again, without fuzzy matching or automatic relocation.
- **Edits preserve text representation.** `edit` preserves existing line endings, untouched separators, and the absence of a final newline. `edit`/`replace` reject invalid UTF-8 source text; all mutations reject NUL and output that cannot be encoded losslessly as UTF-8.
- **Fresh anchors depend on the final observation.** After `then_run`, anchors are shown only for `unchanged` freshness. Without a command, observed and published revisions must agree. Later edits still verify anchors.
- **Local queues are not cross-process transactions.** Revision checks bind mutations to the bytes read, but an external writer can still race a check and publication. There is no strict workspace jail or multi-file transaction.

<details>
<summary><strong>Output budgets, byte fidelity, publication, and result-state details</strong></summary>

### Hashing and BOM handling

`read` computes line hashes only for its requested window; `grep` hashes selected matches/context. Both still read and decode whole files. Mutation revision checks cover actual bytes.

An existing UTF-8 BOM stays at byte zero through first-line replacement/deletion or insertion; deleting all content leaves the BOM. First-line hashes include it. A copied leading BOM in the first replacement/insertion line denotes the existing header; interior `U+FEFF` remains content. BOM-only files retain one anchored line. `replace` can explicitly match the BOM; `write` uses supplied content.

### Output budgets

These limits bound model context, not file size. Omission notices direct the caller to read more.

| Output | Limit |
| --- | --- |
| `read` | Default 2000 rows, overridable with `limit`; 256 KiB of anchored text. No partial anchor rows. |
| `grep` | Default 100 matching lines, overridable; 500 characters per displayed line, plus Pi's total output limits. Hashes use full content; read truncated lines before reconstructing them. |
| `edit` anchors | Up to 40 entries and 16 KiB including heading/omission notice: compact tokens for supplied lines, complete anchored content for deletion successors. |
| `replace` anchors | Up to 40 complete rows and 16 KiB including heading/omission notice. |
| Anchor failure details | 16 KiB, up to 40 detailed failures and eight candidates per ambiguous failure. Unresolved anchors include nearby current-file context, itself capped at 40 rows/16 KiB. |
| Input-anchor checks | Independent 16 KiB block, up to 40 entries in input order. Shown/omitted counts appear only when entries are omitted; omitted entries are not implied matched. |
| Unique-candidate neighborhoods | Up to 40 complete anchored rows/16 KiB of row text, lowest-line first, plus headings. Candidate mappings stay in failure details. Each candidate row is limited to 4 KiB. Truncated rows are omitted in full. |

The diagnostic blocks have independent budgets; their combined output can exceed 16 KiB. Window budgets and omission counts are reported when truncation occurs. Limits apply to rendered diagnostics; core failure results retain all input-anchor checks.

### Publication

The shared commit layer prepares and syncs complete content in a sibling temporary directory. `edit`/`replace` bind publication to the revision of the bytes they read.

| Case | Behavior |
| --- | --- |
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
| `observedRevision` | SHA-256 observed by the commit layer after publication. |
| `actionFusion.command` | `not_requested`, `skipped`, `succeeded`, `failed`, `timeout`, or `cancelled`. |
| `actionFusion.freshness` | `unchanged`, `changed`, `missing`, or `unknown`, relative to the published revision. |
| `actionFusion.mutationCompleted` | Progress flag set after mutation execution and result generation succeed; publication alone is not mutation success. |

Streaming mutation summaries omit anchors. Result-generation failures preserve publication status; progress callback failures are reported separately from mutation/command outcomes. Command output appears on its own card with native Bash rendering. Final cards survive reloads without adding model-context messages; unfinished saved commands show an interrupted/unknown outcome.

</details>

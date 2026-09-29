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
| `read` | Inspect UTF-8 text with line anchors; Pi-supported images and NUL-containing files use Pi's built-in read. Other invalid UTF-8 is rejected. |
| `grep` | Search with bundled ripgrep and return anchored matches/context, file paths, or counts. |
| `edit` | Change specific lines or ranges using verified anchors. |
| `replace` | Replace every occurrence of a literal string or JavaScript regex across one file. |
| `write` | Create a file or replace its complete contents. |

All tools accept relative and absolute paths, `file://` URLs, a leading `@` prefix, and a leading `~` (including `~\` on Windows). As in Pi's built-in file tools, supported Unicode spaces in paths become regular spaces, and Windows shell drive paths using only forward slashes, such as `/c/file`, `/mnt/c/file`, and `/cygdrive/c/file`, resolve to native drive paths. Mixed-separator forms such as `/c/dir\file` do not undergo this drive conversion, matching Pi's built-in tools. Mutation tools share the file-mutation queue and commit layer.

All text inspection and matching uses one logical representation: CRLF boundaries become LF; standalone CR and source-code escape sequences such as the four characters `\r\n` remain content. `read` and `grep` hash the same logical lines that `edit` verifies; literal and regex `replace` both match this LF view. Mutation offsets map back to the original text. `edit` and `replace` share separator restoration: reuse internal separators positionally, repeat the last for extra gaps, or use the file style (CRLF if present, otherwise LF) when none exist. Boundaries outside the replacement stay unchanged.

`write` is the full-content boundary: its supplied bytes are authoritative, so it preserves their explicit LF/CRLF choices. Use it for intentional whole-file line-ending conversion. To inspect actual line-ending bytes, use a raw byte reader; anchored line displays intentionally do not distinguish LF from CRLF.

### Edit operations

`edit` declares a required `path` and a non-empty structured `edits` array. This extension does not normalize alternate formats: stringified JSON and top-level single-op fields are rejected. Pi's own argument validation may convert a single edit object to a one-element array before the extension sees it. Anchors are `"LINE#HASH"` strings whose hash has exactly `hashLen` characters from uppercase Crockford base32 (digits and A–Z except I, L, O, and U). Line numbers are positive safe integers without leading zeroes. Each `body` element is one logical line without CR or LF. An anchor of a different hash length, such as one copied before a `hashLen` change, is rejected before the file is read, and the error names each such anchor.

| `op` | Required | Optional | Effect |
| --- | --- | --- | --- |
| `replace` | `anchor`, `body` | `end` | Replace one line or an inclusive range. |
| `delete` | `anchor` | `end` | Delete one line or an inclusive range; no `body`. |
| `insert_before` / `insert_after` | `anchor`, `body` | — | Insert beside the anchor; keep the anchor line. |
| `prepend` / `append` | `body` | — | Insert at the start/end; no anchors. |

An empty `body: []` deletes the cited range for `replace` and leaves the file unchanged for insertion, `append`, or `prepend`. Anchors and batch validation still apply.

All operations in a batch use the same snapshot. Validation failure rejects the whole batch. Unknown fields, conflicting fields, and overlapping operations are rejected; some touching operations also conflict and need separate calls with fresh anchors. For insertion, **do not repeat the anchor line in `body`**. `edit` uses structured operations, not `oldText`/`newText` pairs.

For multi-operation batches that reach snapshot verification, rejected edits report each supplied anchor's status: `matched` or `mismatched`. Schema-invalid inputs fail before reading the file and have no anchor-status table. Single-operation edits omit the summary table and report the failure directly. Entries identify the zero-based operation index, `anchor` or `end`, and the cited token. The bounded list reports omitted entries explicitly. These statuses do not establish range/overlap validity, semantic intent, publication, command success, or validity on a later retry.

Recovery first searches within `shiftRadius` of the cited line. If that search finds no candidates, it searches the rest of the file and collects all checksum matches before deciding whether the result is unique or ambiguous. Existing local candidates take priority; distant matches are not added when local candidates exist. `shiftRadius: 0` disables both searches. Candidate matching holds the original line number fixed when hashing current content; returned anchors use each candidate's actual line number.

Candidate diagnostics identify the search as `Search: local` or `Search: full file`. Local results explicitly state that matches outside the window were not checked: a unique local candidate does not establish uniqueness across the file. The cited line and returned candidate anchor show the old and current positions.

A unique recovery candidate returns its new anchor and complete line content, without a neighborhood. Content is shown once per line and is limited to 4 KiB per candidate row; oversized content is omitted in full with a prompt to use `read` or `grep`.

Ambiguous failures list up to eight candidate anchors and include a bounded ±3-line neighborhood around each listed candidate from the same snapshot. Windows are clipped to file boundaries, merged, and emitted in ascending line order within byte budgets. Neighboring rows are observations, not recommended replacement targets. Candidate content already present in a neighborhood is not repeated in failure details. Inspect the code to choose the correct anchor and operation, then resubmit. No edit or retry is performed automatically, and every submitted anchor is verified again.

When no candidate is found, diagnostics show the current cited line as a complete `LINE#HASH│content` observation within the 4 KiB row limit. Confirm it is the intended target before reusing its anchor directly. Use `read` or `grep` for additional context, omitted rows, or out-of-range references. Retries revalidate.

### Bulk replacement

For a rename across a file:

```json
{ "path": "src/foo.ts", "replacements": [{ "find": "oldName", "replace": "newName" }] }
```

Literal mode keeps `$` text verbatim. Both literal and regex modes match the shared LF view: actual CRLF in the file and `find` normalizes to LF; standalone CR remains content. Match ranges map back to the original text before replacement, preserving bytes and separators outside each match, including an unmatched BOM or final newline.

Replacement text also normalizes CRLF to LF, then reuses matched separators in order. Additional lines use the last matched separator, or the file style when the match contains no separator (CRLF if present anywhere, otherwise LF).

Regex patterns use JavaScript syntax, unlike `grep`, which uses ripgrep's Rust regex; a pattern that works in one tool may fail or match differently in the other. Add the `m` flag for per-line `^`/`$`. `\d` matches only ASCII digits; `\w` and `\b` are ASCII-based, except that with both `i` and `u` they also treat `ſ` (U+017F) and `K` (U+212A) as word characters through case folding. Regex patterns run on LF text, so use `\n` for a line boundary. Captures and replacement templates also use the LF snapshot; the result then restores original separators. Use `write` for explicit line-ending conversion. Source-code escapes are ordinary text: JSON `"find": "\\r\\n"` finds the visible four-character sequence in literal mode, while `"find": "\r\n"` contains an actual CRLF boundary. Set `regex: true` for JavaScript capture groups and replacement templates:

```json
{ "path": "src/foo.ts", "replacements": [{ "find": "get([A-Z]\\w*)", "replace": "fetch$1", "regex": true }] }
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

Required: non-empty `path`. Optional: positive safe-integer `offset` (1-based; default 1) and positive safe-integer `limit` (default 500 lines, set by `read.defaultLimit`). Fractions, zero, negative values, and unknown fields are rejected. Returned text is capped at 256 KiB by default (`read.maxKiB`); oversized rows are not returned as partial editable lines. Files without a final newline are identified in the header. Content delegated to Pi's built-in read is displayed without interpreting source text as hashline anchors.

When the line limit leaves more content, the result reports the shown range and the next `offset`, for example `showing lines 1-500 of 1200; use offset 501 to continue`. `details.pagination` contains 1-based `start`, inclusive `end`, `totalLines`, and `nextOffset`. This applies to default and explicit limits. Reads reaching EOF omit pagination; byte-limited reads retain their byte-truncation notice and metadata.

### Grep

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pattern` | Required | Non-empty string (including whitespace-only text) or array of non-empty strings; arrays match any pattern (OR). When `ignoreCase` is omitted, smart-case is resolved for the entire query, not separately for each array item. |
| `path` | Current directory | Omit `path` to search the working directory. If supplied, it must be one non-empty existing file or directory, or a non-empty array of search roots; `""` and `[]` are invalid. Wildcards are not expanded; use `glob` to filter filenames. |
| `glob` | None | One non-empty glob or a non-empty ordered array; prefix exclusions with `!`. |
| `literal` | Automatic | Set `true` for literal code text, including regex punctuation such as `pi.on(`; this does not force case-sensitive matching. Set `false` for intentional ripgrep Rust regex, not JavaScript regex: lookaround and backreferences are unsupported, and `^`/`$` match at line boundaries. Automatic mode tries regex for metacharacters; an invalid single-pattern query falls back to searching the **entire string** literally and reports the fallback. Invalid pattern arrays fail instead of changing their meaning; invalid regex with `literal: false` fails. When the pattern contains lookaround or a backreference, the error or fallback notice says so and points to `replace` for JavaScript regex within one file. |
| `ignoreCase` | Smart-case | Query-level case override: `true` ignores case; `false` distinguishes case. Inline regex case flags may override either setting. |
| `multiline` | `false` | Allow matches across physical lines. CRLF is searched as LF; each distinct matched physical line counts toward `limit` and receives an anchor in content mode. `context` alone does not enable cross-line matching. The `.` wildcard still does not match newlines; use `\n` or `(?s)`. |
| `context` | `0` | Integer from 0 to 20: include that many anchored lines before and after each match (pass 3–5 to inspect code blocks without another read). Fractions are rejected, not rounded. Context lines do not count toward `limit`. |
| `limit` | `100` | Positive safe-integer maximum of distinct matching physical lines, across all files and patterns. Reaching the limit produces a notice; it does not prove that another match exists. |
| `outputMode` | `"content"` | `"content"` returns anchored matching lines plus context, `"files"` returns distinct paths, and `"count"` returns matching-line counts per file and a total. All modes use the same limited match set: files and counts may be incomplete when the limit or output byte cap is reached. |

The six former grep fields (`matchMode`, `excludePattern`, `wordMatch`, `pcre2`, `follow`, `noIgnore`) are no longer supported. Calls that contain them, including `false` or `null`, fail before searching; saved session history remains readable, but replaying an old call with these fields requires a new query. They are not silently converted to a different search.

Grep defaults to line-based code searches. With `multiline: true`, OR patterns are scanned separately to retain overlapping spans, and matching physical lines are deduplicated before counting. There is no built-in content exclusion, same-line AND, whole-word switch, or PCRE2. Displaying neighboring lines with `context` does not itself match across lines. More specialized searches require another tool (for example, Bash when available); an empty grep result does not establish that ignored files or linked directories contain no matches.

Directory traversal respects ignore rules, does not follow symbolic links, and includes hidden files. Explicitly named files can still be read through a link or from an ignored directory; ordered `glob` filters still apply to explicit file paths. These rules have different priorities for explicit paths and directory traversal and are not simply intersected.

Searches use bundled ripgrep on the shared LF view, independent of system `rg` or `PATH`. The tool disables external ripgrep configuration with `--no-config` and clears `RIPGREP_CONFIG_PATH`, and uses `--no-crlf` and `--encoding=none` so standalone CR and BOM remain content. NUL-containing files are searched as raw bytes; confirmed content-mode hits are rejected before anchoring, and multiline hits are rejected before mapping physical lines. Files without CRLF are searched at their original paths; CRLF text is normalized into temporary snapshots using bounded reads and writes. Batches contain up to 64 files or 8 MiB of source data (one large file can exceed that threshold); snapshots are removed after each batch and on failure/cancellation. Match paths refer to original files; text line and column positions refer to logical text. Regexes use ripgrep's default Rust-style engine, not PCRE2.

Search diagnostics are preserved even when a result limit stops ripgrep. Readable, confirmed matches remain available with a `Search incomplete` notice and `details.incomplete: true`; counts then cover only confirmed matches. If no results can be returned, the tool reports an error rather than claiming there are no matches. Search diagnostics have a separate 4 KiB display budget.

Long lines show a labeled partial preview of up to 500 UTF-16 units near a reported match column when available; context-only lines and matches without a recorded column show their beginning. Labels report 1-based UTF-16 column ranges, and slicing preserves surrogate pairs. The anchor hashes the entire current line, not the preview; use `read` before reconstructing a line from its content.

### Replace

Required: non-empty `path` and a non-empty `replacements` array. Use one item for a single rule; top-level `find`, `replace`, `regex`, and `flags` are not accepted. Each rule requires non-empty `find` and a `replace` string (which may be empty), with these optional fields:

- `regex`: defaults to `false`; both modes match the shared LF view. Regex mode supports capture groups, the full match, and prefix/suffix substitutions.
- `flags`: applies in both modes; `g` is always added. Only `g i m s u y d` characters are accepted; regex syntax errors are reported per rule before the file is read.

Zero matches in any rule, an invalid rule, or overlapping match ranges rejects the whole call without writing. Adjacent ranges are allowed. Zero-length matches conflict at the same position or at the start/interior of another match; a zero-length match at another match's end is allowed unless it conflicts with a following match. Error rule indices and string offsets are zero-based (offsets count UTF-16 code units in the original text). Literal and regex rules share the same original ranges for conflict detection.

Regex captures and prefix/suffix substitutions always refer to the original LF-normalized snapshot.
Regex batches run in a worker and are terminated on cancellation or when `replace.regexTimeoutMs` (default 5000 ms) elapses. A cancelled or timed-out batch leaves the file unchanged; literal-only batches retain their existing execution path.

### Write

Required: `path`, `content`. By default, create missing files and overwrite existing ones. Content is used exactly as supplied; anchor-looking prefixes are not stripped. Unknown fields, including misspelled modes, are rejected before writing.

- `mode: "create"`: refuse an existing target.
- `mode: "overwrite"`: require an existing target.

Write results report the write outcome without returning line anchors. Use `read` or content-mode `grep` to obtain anchors for a later `edit`.

Normal write result text omits the revision. Programmatic callers can read `details.publishedRevision`; edit and replace use source revisions internally to reject stale writes.

With Action Fusion enabled, `edit`, `replace`, and `write` also accept `then_run`.

All three mutation tools treat identical final content as a successful no-op: report `no net change`, leave the existing file untouched, and return `publication: "NOT_PUBLISHED"`. A requested `then_run` still runs after freshness checks. Input, anchor, match, target-type, mode, and cancellation checks still apply; edit/replace reject stale source revisions, while zero matches and an existing target in create mode remain errors. Creating a missing empty file is a publication, not a no-op.

</details>

## Configuration

Add `hashlineEdit` to Pi's global settings (`~/.pi/agent/settings.json` by default) or the project's `.pi/settings.json`:

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "hashLen": 4,
    "shiftRadius": 15,
    "read": { "defaultLimit": 500, "maxKiB": 256 },
    "grep": { "defaultLimit": 100, "defaultContext": 0 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

Top-level settings apply to every tool; each group applies to one tool.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable all five tools as one unit. Set `false` to restore built-in tools. |
| `actionFusion` | `true` | Expose `then_run` on mutation tools. Set `false` to disable command support. |
| `hashLen` | `4` | Integer checksum length, 2–8 characters. `edit` accepts only anchors of this length; anchors produced under another setting must be read again. |
| `shiftRadius` | `15` | Integer first-pass recovery-search radius, 0–100 lines. With no local candidates, recovery searches the rest of the file; `0` disables both searches. |
| `read.defaultLimit` | `500` | Lines returned when a call omits `limit`; positive safe integer. |
| `read.maxKiB` | `256` | Anchored text returned per call, 1–4096 KiB. Calls cannot raise it. |
| `grep.defaultLimit` | `100` | Matching lines returned when a call omits `limit`; positive safe integer. |
| `grep.defaultContext` | `0` | Context lines shown when a call omits `context`, 0–20. |
| `replace.regexTimeoutMs` | `5000` | Time limit for one regex batch, 1000–300000 ms, including worker startup. |

The project's `hashlineEdit` object replaces the global object as a whole. Each setting is resolved on its own: a missing or invalid setting, or a group that is not an object, uses the defaults while valid neighbors are kept. Types, bounds, and defaults are defined once by the settings schema in `src/pi/config.ts`. Tools receive the resolved configuration at registration, keep it for their lifetime, and state configured defaults in their parameter descriptions. Reload Pi after changes to register tools with the new configuration.

## Action Fusion

Action Fusion is enabled by default. Set `"actionFusion": false` in `hashlineEdit` and reload Pi to disable it; an existing explicit `false` remains effective. Commands run only when a call supplies `then_run`:

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

`command` is required and must contain a non-whitespace character; `timeout` is optional, in seconds greater than zero and at most 2147483.647, with no default. Unknown `then_run` fields are rejected. Invalid command parameters fail before mutation. Mutation failure skips the command. Command failure after mutation success **does not roll back the file**: it is returned separately in result text and `details.actionFusion`, rather than thrown as failure of the whole mutation.

In the TUI, the mutation card owns the mutation's result or error summary, publication status, and freshness warnings. It turns successful when mutation execution and result generation finish. The command card owns command output and execution status; skipped or cancelled commands are neutral and show a short reason when execution never started. Mutation diagnostics never become command output, and command failure leaves a successful mutation card intact. RPC hosts receive the same progress and choose their own rendering.

Fusion serializes each mutation/command sequence for its target and checks the published revision before running the command. Commands invoke Pi's built-in Bash definition directly, without a separate Bash tool call; Bash-only approval/sandbox extensions must explicitly cover these tools' `then_run` inputs.

## Safety and design

- **Anchors are checksums, not identities.** Each hash combines the 1-based line number and content. Short hashes can collide and do not prove the model observed a line.
- **Validation is local to supplied anchors.** Unrelated in-place changes leave stable anchors usable. A range verifies its supplied start/end anchors, not every interior line.
- **Line shifts change anchors.** Insertions/deletions can invalidate later references. Recovery searches within `shiftRadius`, then the rest of the file if no local candidates match. Unique candidates include bounded line content; ambiguous candidates include neighborhoods for comparison. Use `read` when no candidate is found or needed content is omitted. Retries verify again, without fuzzy matching or automatic relocation.
- **Edits preserve text representation.** `edit` preserves existing line endings, untouched separators, and the absence of a final newline. `edit`/`replace` reject invalid UTF-8 source text; all mutations reject NUL and output that cannot be encoded losslessly as UTF-8. Supplied text (`write` content, `edit` body lines, `replace` replacement text) is checked before the file is read, naming the offending field; the final content is checked again before publication, because a transformation such as a regex without `u` can split a surrogate pair. UTF-16 and legacy code pages are not decoded or preserved; a BOM-free file whose bytes happen to be valid UTF-8 may still be misinterpreted.
- **Fresh anchors depend on the final observation.** After `then_run`, anchors are shown only for `unchanged` freshness. Without a command, observed and published revisions must agree. Later edits still verify anchors.
- **Local queues are not cross-process transactions.** Revision checks bind mutations to the bytes read, but an external writer can still race a check and publication. There is no strict workspace jail or multi-file transaction.

<details>
<summary><strong>Output budgets, byte fidelity, publication, and result-state details</strong></summary>

### Hashing and BOM handling

`read` scans text in bounded chunks, validates the whole file, and retains requested line content within its output budget. It reports the total line count and computes hashes for complete output rows. `grep` scans matching files concurrently, retaining only selected matches/context while formatting each file's output. Completed workers retain formatted output blocks in discovery order. NUL-containing files are searched as raw bytes and confirmed content-mode hits are rejected before anchoring. Mutation revision checks cover actual bytes.

Line boundaries are LF or CRLF; a standalone CR remains line content. Anchored rows display standalone CR as `␍` (U+240D), while hashes use the original content. Edit/replace `details.diff` marks raw CR as `␍`; `details.displayDiff` renders the shared LF view for the TUI, so CRLF boundary markers stay hidden even in mixed-ending files or beside an unterminated last line. Standalone CR and literal `␍` characters remain visible. Unified patches retain the original characters and line endings. The marker is a display aid, not replacement text.

An existing UTF-8 BOM stays at byte zero through first-line replacement/deletion or insertion; deleting all content leaves the BOM. First-line hashes include it. A copied leading BOM in the first replacement/insertion line denotes the existing header; interior `U+FEFF` remains content. BOM-only files retain one anchored line. `replace` can explicitly match the BOM; `write` uses supplied content.

### Output budgets

These limits bound model context, not file size. Omission notices direct the caller to read more.

| Output | Limit |
| --- | --- |
| `read` | Default 500 rows (`read.defaultLimit`), overridable with `limit`; 256 KiB of anchored text (`read.maxKiB`). No partial anchor rows. An oversized single row directs the caller to inspect chunks with `bash` or make a known text change with `replace`; reducing `limit` cannot split a physical line. |
| `grep` | Default 100 matching lines (`grep.defaultLimit`), overridable; up to 500 UTF-16 units per partial line preview, plus labels and Pi's total output limits. Match previews use rg byte offsets; hashes use full content. Search error notices have a separate 4 KiB budget. |
| `edit` / `replace` anchors | 16 KiB including heading/omission notice, with no fixed entry-count limit. Compact tokens for changed positions; selected deletion successors retain complete content. The omission notice consumes budget only when rows are omitted. Rows that do not fit are omitted in full; later rows that fit are still returned. |
| Anchor failure details | 16 KiB, with no fixed failure-count limit; unique candidates include complete rows up to 4 KiB, and ambiguous failures list up to eight candidates each. Unresolved anchors show the current cited row when it fits; oversized or out-of-range rows require a fresh `read` or `grep`. |
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
| Durability | Attempt directory synchronization on POSIX, including macOS; tolerate `EINVAL` / `ENOTSUP` from directory fsync and propagate other failures. Windows skips directory synchronization. |
| Cancellation | Every tool reports cancellation as an error starting with `Operation aborted`, matching Pi's built-in tools. Mutation tools add where it stopped and whether the file changed, for example `Operation aborted before apply; src/foo.ts was not changed.` |

### Result and card states

| Field | Meaning |
| --- | --- |
| `publication` | `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`. Fusion also reports it in `actionFusion.publication`. |
| `baseRevision` | SHA-256 of bytes read before mutation, when available. |
| `publishedRevision` | SHA-256 of intended published bytes. |
| `observedRevision` | SHA-256 observed by the commit layer after publication, or at the no-op check. |
| `actionFusion.command` | `not_requested`, `skipped`, `succeeded`, `failed`, `timeout`, or `cancelled`. |
| `actionFusion.freshness` | `unchanged`, `changed`, `missing`, or `unknown`, relative to the published revision. |
| `actionFusion.mutationCompleted` | Progress flag set after mutation execution and result generation succeed; publication alone is not mutation success. |

Streaming mutation summaries omit anchors. Result-generation failures preserve publication status and any completed command outcome; progress callback failures are reported separately from mutation/command outcomes. Command progress `output` contains only command output or execution errors, with an optional `reason` for commands that never started. Command cards persist only their own state and use native Bash output rendering. Final cards survive reloads without adding model-context messages; unfinished saved commands show an interrupted/unknown outcome.

</details>

## Verification

The standalone core API does not load Pi configuration or supply configuration defaults. Direct callers must pass `hashLen` to `computeLineHash(line, content, hashLen)` and `hashFileLines(lines, hashLen)`, and both `hashLen` and `shiftRadius` to `applyEdits(text, edits, hashLen, shiftRadius)`.

- `npm run typecheck` checks source, test, and benchmark types in `src/` and `bench/`.
- `npm run format:check` checks formatting in both directories.
- `npm test` runs core and tool tests.
- `npm run test:integration` exercises bundled ripgrep and files over 100 MiB, including LF and CRLF text.
- `npm run bench` measures core throughput and long-line match mapping.
- `node --expose-gc bench/grep-memory.bench.ts` measures grep latency and sampled peak heap/RSS for 24 files totaling 192 MiB, each with one matching line. It creates and removes its fixtures in the system temporary directory.

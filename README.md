# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model references lines it has read and supplies their new content; the tool checks each anchor against the current file before editing.

Overrides `read`, `grep`, `edit`, and `write`, and adds `replace` for bulk transformations. Optional `forget` drops read/grep result content from model context.

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
| `grep` | Search with bundled ripgrep and return anchored UTF-8 matches/context, plain previews for invalid UTF-8, file paths, or counts. NUL-containing files are skipped. |
| `edit` | Change specific lines or ranges using verified anchors. |
| `replace` | Replace every occurrence of a literal string or JavaScript regex across one file. |
| `write` | Create a file or replace its complete contents. |
| `forget` | When enabled in configuration, drop read or grep result content from model context right after reading it. |

File tools accept relative and absolute paths, `file://` URLs, a leading `@` prefix, and a leading `~` (including `~\` on Windows). As in Pi's built-in file tools, supported Unicode spaces in paths become regular spaces, and Windows shell drive paths using only forward slashes, such as `/c/file`, `/mnt/c/file`, and `/cygdrive/c/file`, resolve to native drive paths. Mixed-separator forms such as `/c/dir\file` do not undergo this drive conversion, matching Pi's built-in tools. Mutation tools share the file-mutation queue and commit layer.

Valid UTF-8 text inspection and matching uses one logical representation: CRLF boundaries become LF; standalone CR and source-code escape sequences such as the four characters `\r\n` remain content. `read` and `grep` hash the same logical lines that `edit` verifies; literal and regex `replace` both match this LF view. Mutation offsets map back to the original text. `edit` and `replace` share separator restoration: reuse internal separators positionally, repeat the last for extra gaps, or use the file style (CRLF if present, otherwise LF) when none exist. Boundaries outside the replacement stay unchanged. Invalid UTF-8 grep previews use raw-byte matching as described below.

`write` is the full-content boundary: its supplied bytes are authoritative, so it preserves their explicit LF/CRLF choices. Use it for intentional whole-file line-ending conversion. To inspect actual line-ending bytes, use a raw byte reader; anchored line displays intentionally do not distinguish LF from CRLF.

### Argument errors

All six tools use one argument-validation entry point. Tool-specific checks collect independent issues instead of stopping at the first one; the response also includes Pi's schema diagnostics. For example, an edit batch can report empty bodies, unwritable text, invalid anchor lengths, and invalid `then_run` fields in one rejection. Schema failures are diagnosed per top-level field, so one field cannot consume another field's diagnostic allowance. Received arguments use compact JSON in both model-facing errors and the TUI. Pi still limits schema errors within each field; the response states that more may remain.

Argument diagnostics share the 16 KiB block budget in [`budgets.ts`](src/pi/budgets.ts), retain opening and closing text, and label omitted text. Invalid arguments prevent execution. Filesystem access, anchor verification, regex probing by ripgrep, and forget eligibility remain subsequent checks that require valid arguments.

### Edit operations

`edit` declares a required `path` and a non-empty structured `edits` array. This extension does not normalize alternate formats: stringified JSON and top-level single-op fields are rejected. Pi's own argument validation may convert a single edit object to a one-element array before the extension sees it. Anchors are `"LINE#HASH"` strings whose hash has exactly `hashLen` characters from uppercase Crockford base32 (digits and A–Z except I, L, O, and U). Line numbers are positive safe integers without leading zeroes. Each `body` element is one logical line without CR or LF. An anchor of a different hash length, such as one copied before a `hashLen` change, is rejected before the file is read, and the error names each such anchor.

| `op` | Required | Optional | Effect |
| --- | --- | --- | --- |
| `replace` | `anchor`, `body` | `end` | Replace one line or an inclusive range. |
| `delete` | `anchor` | `end` | Delete one line or an inclusive range; no `body`. |
| `insert_before` / `insert_after` | `anchor`, `body` | — | Insert beside the anchor; keep the anchor line. |
| `prepend` / `append` | `body` | — | Insert at the start/end; no anchors. |

Every `body` holds at least one line; `[""]` is a single blank line. Remove lines with `delete`. An empty `body: []` is rejected for every operation before the file is read, together with other independently detectable argument errors.

All operations in a batch use the same snapshot. Validation failure rejects the whole batch. Unknown fields, conflicting fields, and overlapping operations are rejected; some touching operations also conflict and need separate calls with fresh anchors. For insertion, **do not repeat the anchor line in `body`**. `edit` uses structured operations, not `oldText`/`newText` pairs.

The TUI edit header shows the total operation count and counts by type, for example `4 ops: replace ×2, delete ×1, append ×1`. During argument streaming, incomplete or unrecognized operation types count as `unknown`; the counts refresh as arguments change.

For multi-operation batches that reach snapshot verification, rejected edits report each supplied anchor's status: `matched` or `mismatched`. Schema-invalid inputs fail before reading the file and have no anchor-status table. Single-operation edits omit the summary table and report the failure directly. Entries identify the zero-based operation index, `anchor` or `end`, and the cited token. The bounded list reports omitted entries explicitly. These statuses do not establish range/overlap validity, semantic intent, publication, command success, or validity on a later retry.

When an anchor no longer matches, `edit` looks for where the line went. Recovery only reports; it never edits or retries by itself:

```text
cited anchor LINE#HASH
  |
  v
hash of the cited line matches? -- yes --> verified
  | no
  v
shiftRadius is 0? -- yes -------------------------------+
  | no                                                  |
  v                                                     |
search within ±shiftRadius lines                        |
  |                                                     |
  v                                                     |
any local candidate? -- no --> search the rest          |
  | yes                        of the file              |
  v                                 |                   |
how many candidates? <--------------+                   |
  |                                                     |
  +-- one -----> unique: new anchor and full row        |
  |                                                     |
  +-- several -> ambiguous: first 8 anchors and         |
  |              ±3-line neighborhoods                  |
  |                                                     |
  +-- none ----> unresolved: current cited row <--------+

Every outcome rejects the whole batch and writes nothing;
inspect the result and resubmit.
```

- Candidates are found by hashing each line's current content with the **cited** line number; each returned anchor uses the candidate's actual line number, so the details show both the old and current positions. Diagnostics say `Search: local` or `Search: full file`. A unique local candidate does not establish uniqueness across the file, because matches outside the window were not checked.
- A unique candidate shows its new anchor and complete row once, without a neighborhood. Rows over 4 KiB are omitted in full with a prompt to use `read` or `grep`.
- Ambiguous neighborhoods come from the same snapshot, are clipped to file boundaries, merged, and emitted in ascending line order within byte budgets. Their rows are observations, not suggested targets; candidate content already shown there is not repeated in the failure details.
- With no candidate, the current cited row is shown as a complete `LINE#HASH│content` observation within the 4 KiB row limit. Confirm it is the intended target before reusing its anchor; use `read` or `grep` for more context, omitted rows, or out-of-range lines.

Every submitted anchor is verified again on retry.

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
<summary><strong>Full read, grep, replace, write, and forget parameter reference</strong></summary>

### Read

Required: non-empty `path`. Optional: positive safe-integer `offset` (1-based; default 1) and positive safe-integer `limit` (default 500 lines, set by `read.defaultLimit`). Fractions, zero, negative values, and unknown fields are rejected. Returned text is capped at 256 KiB by default (`read.maxKiB`); oversized rows are not returned as partial editable lines. Files without a final newline are identified in the header. Content delegated to Pi's built-in read is displayed without interpreting source text as hashline anchors.

When the line limit leaves more content, the result reports the shown range and the next `offset`, for example `showing lines 1-500 of 1200; use offset 501 to continue`. `details.pagination` contains 1-based `start`, inclusive `end`, `totalLines`, and `nextOffset`. This applies to default and explicit limits. Reads reaching EOF omit pagination; byte-limited reads retain their byte-truncation notice and metadata.

### Grep

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pattern` | Required | Non-empty string (including whitespace-only text) or array of non-empty strings; arrays match any pattern (OR). When `ignoreCase` is omitted, smart-case is resolved for the entire query, not separately for each array item. |
| `path` | Current directory | Omit `path` to search the working directory. If supplied, it must be one non-empty existing file or directory, or a non-empty array of search roots; `""` and `[]` are invalid. Wildcards are not expanded; use `glob` to filter filenames. |
| `glob` | None | One non-empty glob or a non-empty ordered array; prefix exclusions with `!`. |
| `literal` | Required | `true` matches every pattern as exact text, including regex punctuation such as `pi.on(`; use it for names, paths, and code snippets. It does not force case-sensitive matching. `false` treats every pattern as ripgrep Rust regex, not JavaScript regex: lookaround and backreferences are unsupported, `^`/`$` match at line boundaries, and a valid regex such as `foo(0)` matches `foo0`, not `foo(0)`. An invalid regex fails before any file is searched; when it contains lookaround or a backreference, the error says so and points to `replace` for JavaScript regex within one file, otherwise it suggests `literal: true`. |
| `ignoreCase` | Smart-case | Query-level case override: `true` ignores case; `false` distinguishes case. Inline regex case flags may override either setting. |
| `multiline` | `false` | Allow matches across physical lines. Valid UTF-8 CRLF is searched as LF; each distinct matched physical line counts toward `limit`. Content mode adds anchors only for valid UTF-8 files. `context` alone does not enable cross-line matching. The `.` wildcard still does not match newlines; use `\n` or `(?s)`. |
| `context` | `0` | Integer from 0 to 20: include that many lines before and after each match (pass 3–5 to inspect code blocks without another read). Fractions are rejected, not rounded. Context lines do not count toward `limit`. |
| `limit` | `100` | Positive safe-integer maximum of distinct matching physical lines, across all files and patterns. Reaching the limit produces a notice; it does not prove that another match exists. |
| `outputMode` | `"content"` | `"content"` returns matching lines plus context, with anchors for valid UTF-8 or plain line numbers for invalid UTF-8; `"files"` returns distinct paths, and `"count"` returns matching-line counts per file and a total. All modes use the same limited match set: files and counts may be incomplete when the limit or output byte cap is reached. |

The six former grep fields (`matchMode`, `excludePattern`, `wordMatch`, `pcre2`, `follow`, `noIgnore`) are no longer supported. Calls that contain them, including `false` or `null`, fail before searching; saved session history remains readable, but replaying an old call with these fields requires a new query. They are not silently converted to a different search.

Grep defaults to line-based code searches. With `multiline: true`, OR patterns are scanned separately to retain overlapping spans, and matching physical lines are deduplicated before counting. There is no built-in content exclusion, same-line AND, whole-word switch, or PCRE2. Displaying neighboring lines with `context` does not itself match across lines. More specialized searches require another tool (for example, Bash when available); an empty grep result does not establish that ignored files or linked directories contain no matches.

Directory traversal respects ignore rules, does not follow symbolic links, and includes hidden files. Explicitly named files can still be read through a link or from an ignored directory; ordered `glob` filters still apply to explicit file paths. These rules have different priorities for explicit paths and directory traversal and are not simply intersected.

Searches use bundled ripgrep, independent of system `rg` or `PATH`. The tool disables external ripgrep configuration with `--no-config` and clears `RIPGREP_CONFIG_PATH`, and uses `--no-crlf` and `--encoding=none` so standalone CR and BOM remain content. NUL-containing files are silently skipped in all output modes, including explicitly named files; they do not consume the match limit. Valid UTF-8 files use the shared LF view: files without CRLF are searched at their original paths, and CRLF text is normalized into temporary snapshots using bounded reads and writes. Batches contain up to 64 files or 8 MiB of source data (one large file can exceed that threshold); snapshots are removed after each batch and on failure/cancellation. Match paths refer to original files. Regexes use ripgrep's default Rust-style engine, not PCRE2.

Files with invalid UTF-8 and no NUL remain searchable as raw bytes, without CRLF normalization or encoding conversion. Multiline queries for these files must match their actual separators, such as `\r\n`. Ripgrep's Unicode regex rules still apply; use a byte-mode group such as `(?-u:...)` when the pattern must span malformed bytes. Content-mode output uses replacement characters and plain `LINE│content` rows for the entire file, including context, followed by `Invalid UTF-8: replacement characters shown; plain line numbers cannot be used as edit anchors`. These previews are not editable anchors. Files/count modes include their confirmed matches. Unmatched invalid UTF-8 files produce no warning. Content output still verifies the file's byte revision before returning results.

Search diagnostics are preserved even when a result limit stops ripgrep. Readable, confirmed matches remain available with a `Search incomplete` notice and `details.incomplete: true`; counts then cover only confirmed matches. If no results can be returned, the tool reports an error rather than claiming there are no matches. Search diagnostics have a separate 4 KiB display budget. Ripgrep stderr and batch aggregation each retain up to 64 KiB. All three limits preserve opening context and the final cause where lines fit, and explicitly mark omitted middle text. The shared implementation is [`DiagnosticBuffer`](src/pi/diagnostic-buffer.ts); limits live in [`budgets.ts`](src/pi/budgets.ts) and [`rg-process.ts`](src/pi/rg-process.ts).

All file-tool errors retain every text block in the TUI, including validation causes and recovery hints. Short errors are shown in full when collapsed; longer errors use the same collapsed preview and expansion as grep results. Expanding reveals all retained diagnostic text, including edit recovery context and combined Action Fusion failure details. These display limits do not shorten the tool result sent to the model.

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

### Forget

Forget is disabled by default. Set `"forget": true` in `hashlineEdit` and reload Pi to enable it. While disabled, the extension registers neither the `forget` tool nor its context hooks, and read/grep results carry no result tags. Disabling it does not undo context edits already stored in the session.

`read` results and content-mode `grep` results of at least 2 KiB of text, and image reads, end with a separate `[result rXXXXX]` block. Smaller results, errors, and `files`/`count` grep output carry no tag. `forget` takes `ids` (a non-empty array of distinct tags) and an optional non-empty `note` for facts to keep.

Only results from the step the model has just seen can be forgotten: the tagged results after its previous response. Any other id rejects the whole call and lists the ids that are available. After the response that called `forget` completes, Pi's context edits replace the entire content of each named result with `[Result rXXXXX: content forgotten; rerun the call to see it again.]`. This removes all text and images, including headers, pagination, truncation and search notices, without inspecting their contents. The tool call, the rest of the exchange, and the `forget` call with its `note` stay in context. Save facts you still need in `note` before forgetting. Files, the raw session, and the TUI are unchanged; navigating to a point before the edit restores the original result.

The `forget` card in the TUI shows the result count in its header, for example `forget · 2 results`, followed by what was forgotten: `build.log · lines 100–200` (with `· truncated` when the read hit its byte limit), `photo.png · image`, or `grep /pattern/ · 12 matches in 3 files` (with `· limit reached` or `· incomplete`). Expanding the card shows each result id beside its receipt; results without a detailed receipt show their id in either view. An optional `note` appears below the header. read and grep keep receipts in result details, which Pi does not send to the model; the model sees only `Forgot rXXXXX.`.

The restriction bounds how much of the next request changes. Messages before the earliest forgotten result stay as they were; from that result on, the request differs, which covers any later results from the same batch (even ones not forgotten), the response that called `forget`, and its tool results. Forgetting an older result would change every later message. This describes request contents only; how a provider bills prompt caching for the changed part is not measured here.

After `forget` completes, Pi continues with the next model request as it does for other tools. The selected results have already been replaced with receipts when that request is sent.

</details>

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
    "read": { "defaultLimit": 500, "maxKiB": 256 },
    "grep": { "defaultLimit": 100, "defaultContext": 0 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

Top-level settings control shared behavior; each group configures one tool.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the extension. Set `false` to register no tools or hooks and restore built-in tools. |
| `actionFusion` | `true` | Expose `then_run` on mutation tools. Set `false` to disable command support. |
| `forget` | `false` | Register `forget` and tag eligible read/grep results for context removal. |
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

`command` is required and must contain a non-whitespace character; `timeout` is optional, in seconds greater than zero and at most 2147483.647, with no default. Unknown `then_run` fields are rejected.

```text
edit / replace / write with then_run
  |
  v
then_run valid? -- no --> rejected before the file is touched
  | yes
  v
wait for this file's Fusion queue
  |
  v
mutation completes? -- no, or cancelled first --> mutation error;
  | yes                                           command skipped or cancelled
  v
file still at the published revision? -- no --> command skipped --+
  | yes                                                           |
  v                                                               |
run the command with Pi's built-in Bash                           |
(succeeded / failed / timeout / cancelled)                        |
  |                                                               |
  v                                                               |
file unchanged at the end? <--------------------------------------+
  |
  +-- yes --> mutation result (edit/replace include fresh anchors),
  |           then the command outcome
  |
  +-- no ---> mutation result with the [then_run:stale] notice,
              then the command outcome
```

Once the mutation completes, it stays successful whatever happens to the command: command failure **does not roll back the file**. The command outcome is returned separately in result text and `details.actionFusion`, rather than thrown as failure of the whole mutation.

In the TUI, the mutation card owns the mutation's result or error diagnostics, publication status, and freshness warnings. It turns successful when mutation execution and result generation finish. The command card owns command output and execution status; skipped or cancelled commands are neutral and show a short reason when execution never started. Mutation diagnostics never become command output, and command failure leaves a successful mutation card intact. RPC hosts receive the same progress and choose their own rendering.

When `then_run.timeout` is supplied, the command card shows the remaining seconds and refreshes once per second even without command output. The countdown starts when the command starts, after mutation and queue waiting. It stops when execution ends; restored unfinished cards show an unknown final status without a countdown. Pi Bash enforces the timeout. Without `timeout`, there is no countdown or implicit time limit. RPC progress includes `timing.timeoutSeconds` and `timing.remainingSeconds` after a timed command starts.

Command failures return Pi Bash's diagnostic text to the LLM, including exit or timeout details and whether file changes were saved. Collapsing a TUI card does not shorten the model's result.

The Fusion queue holds a file from mutation until its command finishes, so another fused call on the same file cannot change it in between. Commands invoke Pi's built-in Bash definition directly, without a separate Bash tool call; Bash-only approval/sandbox extensions must explicitly cover these tools' `then_run` inputs.

## Safety and design

- **Anchors are checksums, not identities.** Each hash combines the 1-based line number and content. Short hashes can collide and do not prove the model observed a line.
- **Validation is local to supplied anchors.** Unrelated in-place changes leave stable anchors usable. A range verifies its supplied start/end anchors, not every interior line.
- **Line shifts change anchors.** Insertions/deletions can invalidate later references. Recovery searches within `shiftRadius`, then the rest of the file if no local candidates match. Unique candidates include bounded line content; ambiguous candidates include neighborhoods for comparison. Use `read` when no candidate is found or needed content is omitted. Retries verify again, without fuzzy matching or automatic relocation.
- **Edits preserve text representation.** `edit` preserves existing line endings, untouched separators, and the absence of a final newline. `edit`/`replace` reject invalid UTF-8 source text; all mutations reject NUL and output that cannot be encoded losslessly as UTF-8. Supplied text (`write` content, `edit` body lines, `replace` replacement text) is checked before the file is read, naming the offending field; the final content is checked again before publication, because a transformation such as a regex without `u` can split a surrogate pair. UTF-16 and legacy code pages are not decoded or preserved; a BOM-free file whose bytes happen to be valid UTF-8 may still be misinterpreted.
- **Fresh anchors depend on the final observation.** After `then_run`, anchors are shown only for `unchanged` freshness. Without a command, observed and published revisions must agree. Otherwise every mutation result, including `write`, ends with one notice to re-read before further edits, prefixed with `[then_run:stale]` when a command was requested. Later edits still verify anchors.
- **Local queues are not cross-process transactions.** Revision checks bind mutations to the bytes read, but an external writer can still race a check and publication. There is no strict workspace jail or multi-file transaction.

<details>
<summary><strong>Output budgets, byte fidelity, publication, and result-state details</strong></summary>

### Hashing and BOM handling

`read` scans text in bounded chunks, validates the whole file, and retains requested line content within its output budget. It reports the total line count and computes hashes for complete output rows. `grep` scans matching files concurrently, retaining only selected matches/context while formatting each file's output. Completed workers retain formatted output blocks in discovery order. It skips NUL-containing files and generates anchors only for files whose complete contents are valid UTF-8. Invalid UTF-8 previews and anchored output both retain byte revision checks. Mutation revision checks cover actual bytes.

Line boundaries are LF or CRLF; a standalone CR remains line content. Anchored rows display standalone CR as `␍` (U+240D), while hashes use the original content. Edit/replace `details.diff` marks raw CR as `␍`; `details.displayDiff` renders the shared LF view for the TUI, so CRLF boundary markers stay hidden even in mixed-ending files or beside an unterminated last line. Standalone CR and literal `␍` characters remain visible. Unified patches retain the original characters and line endings. The marker is a display aid, not replacement text.

An existing UTF-8 BOM stays at byte zero through first-line replacement/deletion or insertion; deleting all content leaves the BOM. First-line hashes include it. A copied leading BOM in the first replacement/insertion line denotes the existing header; interior `U+FEFF` remains content. BOM-only files retain one anchored line. `replace` can explicitly match the BOM; `write` uses supplied content.

### Output budgets

These limits bound model context, not file size. Omission notices direct the caller to read more.

| Output | Limit |
| --- | --- |
| `read` | Default 500 rows (`read.defaultLimit`), overridable with `limit`; 256 KiB of anchored text (`read.maxKiB`). No partial anchor rows. An oversized single row directs the caller to inspect chunks with `bash` or make a known text change with `replace`; reducing `limit` cannot split a physical line. |
| `grep` | Default 100 matching lines (`grep.defaultLimit`), overridable; up to 500 UTF-16 units per partial line preview, plus labels and Pi's total output limits. Match previews use rg byte offsets; hashes use full content. Search error notices have a separate 4 KiB budget. |
| `forget` tag | With `forget` enabled: `read` and content-mode `grep` text results of 2 KiB or more, and image reads; smaller results are not tagged. |
| `edit` / `replace` anchors | 16 KiB including heading/omission notice, with no fixed entry-count limit. Compact tokens for changed positions; selected deletion successors retain complete content. The omission notice consumes budget only when rows are omitted. Rows that do not fit are omitted in full; later rows that fit are still returned. |
| Argument errors | 16 KiB for the combined tool-specific and Pi schema diagnostics; longer reports retain opening/closing text and label the omitted middle. Pi's schema error limit applies separately within each top-level field. |
| Anchor failure details | 16 KiB, with no fixed failure-count limit; unique candidates include complete rows up to 4 KiB, and ambiguous failures list up to eight candidates each. Unresolved anchors show the current cited row when it fits; oversized or out-of-range rows require a fresh `read` or `grep`. |
| Input-anchor checks | Independent 16 KiB block, with no fixed entry-count limit. Truncation is reported explicitly; omitted entries are not implied matched. |
| Ambiguous-candidate neighborhoods | 16 KiB of complete anchored row text, lowest-line first, plus headings; no fixed row-count limit. Uses the same first eight candidates per failure as the detail lists. Each listed candidate row is limited to 4 KiB. Rows exceeding either limit are omitted in full; later rows that fit are still returned, with gaps reflected in the neighborhood headings. |

The diagnostic blocks have independent budgets; their combined output can exceed 16 KiB. Truncation notices identify exhausted budgets; context windows also report shown/omitted row counts. Limits apply to rendered diagnostics; core failure results retain all input-anchor checks.

### Publication

All three mutation tools publish through one commit layer. `edit`/`replace` bind it to the revision of the bytes they read:

```text
validate content and target: regular file,   -- fails --> NOT_PUBLISHED
single link, mode, expected revision
  |
  v
same bytes as the current file?              -- yes ----> no-op: NOT_PUBLISHED,
  | no                                                    target untouched
  v
write and fsync complete content in a        -- fails --> NOT_PUBLISHED
sibling temporary directory
  |
  v
edit/replace: still at the revision read?    -- no -----> NOT_PUBLISHED
  | yes
  v
create:    link(temp, target)                -- target appeared -> NOT_PUBLISHED
overwrite: rename(temp, target)              -- other failure ---> UNKNOWN
  |
  v
sync directory (POSIX), read back the revision,
remove the temporary directory
  |
  v
PUBLISHED, even if a step after publication fails
```

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

- `npm run typecheck` checks source, test, and benchmark types in `src/` and `bench/`.
- `npm run format:check` checks formatting in both directories.
- `npm test` runs core and tool tests.
- `npm run test:integration` exercises bundled ripgrep and files over 100 MiB, including LF and CRLF text.
- `npm run bench` measures core throughput and long-line match mapping.
- `node --expose-gc bench/grep-memory.bench.ts` measures grep latency and sampled peak heap/RSS for 24 files totaling 192 MiB, each with one matching line. It creates and removes its fixtures in the system temporary directory.

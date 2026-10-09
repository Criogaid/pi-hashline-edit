# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model references lines it has read and supplies their new content; the tool checks each anchor against the current file before editing.

Overrides `read`, `grep`, `edit`, and `write`, and adds `replace` for bulk transformations. Optional `forget` drops read/grep result content from model context.

- **Search → edit:** `read` and `grep` return the same `LINE#HASH` anchors, so search results can feed directly into edits.
- **Batch and chain edits:** submit structured JSON operations together, then use the returned fresh anchors for the next change.
- **Recover from stale anchors:** rejected edits show a unique checksum-matching candidate's line, or neighborhoods around ambiguous candidates for comparison. With no candidate, they show the current cited row as an observation. Like every tool error, the rejection is one JSON record whose single `next` instruction asks the model to confirm the target or re-read. Recovery never applies automatically.
- **Edit → test:** Action Fusion lets a mutation include an optional follow-up command, with separate file and command outcomes and separate TUI cards.

[Quick start](#quick-start) · [Tools](#tools) · [Configuration](#configuration) · [Action Fusion](#action-fusion) · [Safety and design](#safety-and-design)

## Install

```bash
pi install npm:@criogaid/pi-hashline-edit
```

This extension works on **local files**. For remote/custom-storage operations, disable it in [configuration](#configuration) and reload Pi to use the built-in tools.

## Quick start

Once installed, Pi's model uses these tool calls automatically. The examples below show the read → edit protocol.

A `read` of `greet.ts` returns a JSON report. Its `payload` contains the original anchor rows:

```json
{
  "version": 1,
  "tool": "read",
  "outcome": "success",
  "path": "greet.ts",
  "read": { "start": 1, "end": 3, "totalLines": 3, "native": false, "finalNewline": true, "truncated": false, "maxBytes": 262144, "omittedRows": 0 },
  "payload": ["1#ZR63│export function greet() {\n2#GFYR│  return \"hello\";\n3#FNSZ│}"]
}
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

The TUI shows the diff. The report includes the following `anchors` field:

```json
{ "rows": "2#V8AT", "omitted": 0, "maxBytes": 16384 }
```

Use returned anchors for changed lines in subsequent edits. Previously observed anchors remain usable when their line number, full content, and hash-length configuration are unchanged. Content-mode `grep` provides the same references, grouped by file. Always copy actual tool output; the examples use the default four-character hash.

Successful `edit` and `replace` results omit positions whose full content at the same line number is unchanged, then return compact `LINE#HASH` tokens in `anchors.rows`. `edit` retains complete content for a deletion successor unless the batch also supplies that row; `replace` retains it for the first surviving line after a pure deletion. Complete anchor rows have the 16 KiB payload budget in [`budgets.ts`](src/pi/budgets.ts); `anchors.omitted` counts rows that did not fit, without a fixed entry-count limit. Neither tool reports every shifted line in the remaining file; read shifted positions when needed. `write` returns no anchors. Explicit `read`/`grep` payloads and edit failure context retain their content rows.

## Tools

| Tool | Use it for |
| --- | --- |
| `read` | Inspect UTF-8 text with line anchors; Pi-supported images and NUL-containing files use Pi's built-in read. Other invalid UTF-8 is rejected. |
| `grep` | Search with bundled ripgrep and return anchored UTF-8 matches/context, plain previews for invalid UTF-8, file paths, or counts. NUL-containing files are skipped. |
| `edit` | Change, copy, or move whole lines and ranges using verified anchors. |
| `replace` | Replace every occurrence of a literal string or JavaScript regex across one file. |
| `write` | Create a file or replace its complete contents. |
| `forget` | When enabled in configuration, drop read or grep result content from model context right after reading it. |

File tools accept relative and absolute paths, `file://` URLs, a leading `@` prefix, and a leading `~` (including `~\` on Windows). As in Pi's built-in file tools, supported Unicode spaces in paths become regular spaces, and Windows shell drive paths using only forward slashes, such as `/c/file`, `/mnt/c/file`, and `/cygdrive/c/file`, resolve to native drive paths. Mixed-separator forms such as `/c/dir\file` do not undergo this drive conversion, matching Pi's built-in tools. Mutation tools share the file-mutation queue and commit layer.

Grep returns paths that can be copied back into these tools unchanged. It preserves literal backslashes in POSIX filenames and adds `./` when a relative name would otherwise be interpreted as an input prefix. Names requiring escaping, including supported Unicode spaces or line breaks, use encoded `file://` URLs.

Valid UTF-8 text inspection and matching uses one logical representation: CRLF boundaries become LF; standalone CR and source-code escape sequences such as the four characters `\r\n` remain content. `read` and `grep` hash the same logical lines that `edit` verifies; literal and regex `replace` both match this LF view. Mutation offsets map back to the original text. `edit` and `replace` share separator restoration: reuse internal separators positionally, repeat the last for extra gaps, or use the file style (CRLF if present, otherwise LF) when none exist. Boundaries outside the replacement stay unchanged. Invalid UTF-8 grep previews use raw-byte matching as described below.

`write` is the full-content boundary: its supplied bytes are authoritative, so it preserves their explicit LF/CRLF choices. Use it for intentional whole-file line-ending conversion. To inspect actual line-ending bytes, use a raw byte reader; anchored line displays intentionally do not distinguish LF from CRLF.

### Reports and errors

Every plugin success and failure uses the schema-owned report in [`core/report-schema.ts`](src/core/report-schema.ts). [`report.ts`](src/pi/report.ts) serializes it into one JSON text block. Images remain native image blocks. When forgetting is enabled, its existing `[result rXXXXX]` identity tag remains a separate protocol block; it is not a diagnostic notice. There are no generated bracket suffixes for truncation, stale targets, search warnings, or commands.

An anchor rejection has this shape:

```json
{
  "version": 1,
  "tool": "edit",
  "outcome": "failure",
  "path": "src/foo.ts",
  "error": "ANCHOR_MISMATCH",
  "message": "Edit anchor verification failed.",
  "facts": {
    "failures": [{ "field": "edits[0].anchor", "op": "replace", "cited": "12#ABCD", "result": "unresolved", "observed": "12#EFGH│const value = 2;" }]
  },
  "mutation": { "publication": "NOT_PUBLISHED", "stage": "prepare" },
  "next": "Before reusing a candidate or observed anchor, confirm it is the intended target; use read or grep for omitted rows, out-of-range lines, or more context. Retries verify every anchor again."
}
```

Optional sections are absent when they do not apply. The renderer emits sections in this fixed order:

| Field | Meaning |
| --- | --- |
| `version`, `tool`, `outcome`, `path` | Report version, one of the six tools, success/failure, and the supplied path. |
| `error`, `message`, `facts` | Failure only: code, the throwing layer’s own step, and facts defined by that code’s schema. |
| `causes` | Bounded native/inner failures with `name`, `message`, `depth`, optional aggregate `branch`, and explicit omission counts. Causes are never concatenated into the outer message. |
| `mutation` | Commit-owned publication, stage, creation, revisions, freshness, and revision-observation causes. |
| `command` | Fusion-owned status, `blockedBy`, output, causes of command execution, and `terminate`. |
| `read`, `search`, `edit`, `replace`, `forget` | Feature-owned pagination/truncation, search completeness/limits/diagnostics, operation count, match count, or forgotten ids. |
| `anchors` | Complete anchor rows, omitted-row count, and payload byte limit. |
| `progressFailures` | Observer failures; they do not change mutation or command outcomes. |
| `payload` | Read rows, grep rows/paths/counts, or opaque native read content, as strings. |
| `next` | One final recovery instruction derived centrally from the code, publication, and feature facts. |

The commit layer owns file state; Fusion references that state through `blockedBy: "target"` or `"revision"` rather than adding a stale-target sentence. A failed mutation that is `PUBLISHED` must not be repeated; `UNKNOWN` requires inspection before retrying. Both paths reuse the same instruction to read before further edits. Success reports with stale targets use that instruction too. Per-code recovery overrides are restricted to the selectors declared in the error definition.

The following table is derived from `errorDefinitions` in [`core/report-schema.ts`](src/core/report-schema.ts); update the definition and regenerate/check these rows together.

| Code | Raised when |
| --- | --- |
| `INVALID_ARGUMENTS` | Arguments fail preparation, schema validation, or semantic checks. |
| `OPERATION_ABORTED` | The call was cancelled. |
| `PATH_NOT_FOUND` | Only ENOENT or overwrite of a missing target. |
| `FILESYSTEM_ERROR` | A filesystem operation failed. |
| `FILE_CHANGED` | A read, search, or pre-publication revision changed. |
| `UNSUPPORTED_ENCODING` | Confirmed malformed UTF-8. |
| `UNSUPPORTED_TEXT` | Text contains NUL. |
| `INVALID_UNICODE` | Content cannot be encoded losslessly as UTF-8. |
| `ANCHOR_MISMATCH` | Edit anchors do not match the snapshot. |
| `INVALID_RANGE` | An edit range or move destination is invalid. |
| `OVERLAPPING_EDITS` | Edit mutations overlap. |
| `NO_MATCH` | A replace rule has no matches. |
| `OVERLAPPING_MATCHES` | Replace match ranges overlap. |
| `REGEX_TIMEOUT` | Regex evaluation exceeded its timeout. |
| `REGEX_WORKER_FAILED` | The regex worker failed. |
| `TARGET_EXISTS` | Create mode names an existing target. |
| `NOT_REGULAR_FILE` | The target is not a regular file. |
| `MULTIPLE_HARD_LINKS` | The target has multiple hard links. |
| `SYMLINK_UNRESOLVED` | The symlink target cannot be resolved. |
| `PUBLISH_FAILED` | Publication failed or is uncertain. |
| `POST_PROCESS_FAILED` | A post-publication step failed. |
| `INVALID_REGEX` | Ripgrep rejected a regex. |
| `SEARCH_INCOMPLETE` | No confirmed search output is available. |
| `RIPGREP_FAILED` | Ripgrep failed or returned unusable output. |
| `UNSUPPORTED_PATH` | A search path is not valid UTF-8. |
| `NOT_FORGETTABLE` | Ids are not eligible results of the preceding step. |
| `UNCLASSIFIED` | An unclassified external failure. |

Pi sends `content` to the model and keeps `details` for UI/logging. The plugin returns execution failures with `isError: true` and `details.report`; TUI renderers consume that structured object and never parse model text. Preparation must throw before execution. Its `ReportedToolError` carries the same report, which registration retains by raw argument identity for live TUI rendering. Pi discards thrown details; restored preparation failures and foreign host failures therefore use opaque text when no structured report is available. RPC hosts choose their own presentation.

#### Argument errors

All six tools use one argument-validation entry point. Tool-specific checks collect independent issues instead of stopping at the first one. Failure diagnostics use Pi's prepared values and the declared schema. A recognised operation selects its branch; a missing or invalid operation reports only its `op` field. A non-object operation reports its type once. String/array unions select the applicable type, and literal unions report their permitted values once.

Diagnostics combine distinct constraints on one field and omit duplicate parent summaries. A tool-specific explanation replaces schema messages for that value only when its field belongs to the selected shape; forbidden fields and unknown operations receive no inapplicable body or anchor advice. Missing required fields and other independent errors remain visible. Each top-level field has a separate native diagnostic allowance. The original schema and Pi pipeline still control acceptance, coercion, and optional null handling.

An argument rejection uses the same failure model. Its `facts` contain `executed: false`, typed `issues`, and a prepared argument copy when it fits. Each issue separates its `fact` from an optional field-specific `fix`:

```json
{
  "version": 1,
  "tool": "edit",
  "outcome": "failure",
  "error": "INVALID_ARGUMENTS",
  "message": "Arguments were rejected before execution.",
  "facts": {
    "executed": false,
    "issues": [{ "field": "edits[0].body", "fact": "is empty", "fix": "remove this edit or supply at least one line ([\"\"] for a blank line)." }],
    "arguments": { "path": "example.txt", "edits": [{ "op": "insert_after", "anchor": "22#ABCD", "body": [] }] }
  },
  "mutation": { "publication": "NOT_PUBLISHED", "stage": "prepare" },
  "next": "Correct the reported fields and submit the complete call."
}
```

The TUI styles field names and recursively displays facts, fixes, and omission markers. Collapsed cards use the shared bounded preview; expansion reveals every retained field.

`issues` combines schema and tool-specific failures. Field paths refer to Pi's prepared arguments: array indices use `[0]`, named properties use dots, and other property names use JSON-quoted brackets. `$` identifies a preparation failure without a field diagnostic. `arguments` contains the prepared value, including Pi coercion, when it fits and can be encoded.

Within an edit operation, omit an optional `end` when no range is needed. `end: null` remains a schema error, including when other arguments are invalid.

Argument diagnostics share the 16 KiB serialized-report budget in [`budgets.ts`](src/pi/budgets.ts) and remain valid JSON. An oversized or unavailable argument copy becomes `argumentsOmitted: true`. Oversized reports retain whole opening and closing issues and count omissions in `omittedIssues`; an oversized field path is omitted whole. Each `fact` and `fix` has the 4 KiB text budget; preparation causes share a bounded cause block. `schemaLimited: true` means additional native issues may remain. Invalid arguments prevent execution. Filesystem access, anchor verification, regex probing by ripgrep, and forget eligibility remain subsequent checks.

### Edit operations

`edit` declares a required `path` and non-empty structured `edits` array. Stringified JSON and top-level single-op fields are rejected. Pi may coerce a single edit object into a one-element array before the extension sees it. Anchors are `"LINE#HASH"` strings whose hash has exactly `hashLen` uppercase Crockford base32 characters (digits and A–Z except I, L, O, U). Line numbers are positive safe integers without leading zeroes. Each `body` element is one logical line without CR or LF. A hash-length mismatch is rejected before file access; each affected field has a fact and a separate fix.

| `op` | Required | Optional | Effect |
| --- | --- | --- | --- |
| `replace` | `anchor`, `body` | `end` | Replace one line or an inclusive range. |
| `delete` | `anchor` | `end` | Delete one line or an inclusive range; no `body`. |
| `copy` / `move` | `anchor`, exactly one of `before` / `after` | `end` | Transfer original lines within the same file; `move` also removes the source. No `body`. |
| `insert_before` / `insert_after` | `anchor`, `body` | — | Insert beside the anchor; keep the anchor line. |
| `prepend` / `append` | `body` | — | Insert at the start/end; no anchors. |

Every `body` holds at least one line; `[""]` is a single blank line. Remove lines with `delete`. An empty `body: []` is rejected for every operation before the file is read, together with other independently detectable argument errors.

If an edit leaves a blank line at the end, it writes the terminator needed to preserve that logical line, even when the original file lacked a final newline. For example, appending `[""]` to `"a"` produces `"a\n\n"`; replacing its only line with `[""]` produces `"\n"`. A BOM-only file already represents one blank line and keeps its BOM without an extra terminator. A non-empty final line retains the original final-newline state.

All operations in a batch use the same snapshot. Validation failure rejects the whole batch. Unknown fields, conflicting fields, and overlapping operations are rejected; some touching operations also conflict and need separate calls with fresh anchors. For insertion, **do not repeat the anchor line in `body`**. `edit` uses structured operations, not `oldText`/`newText` pairs.

For `copy` and `move`, `anchor/end` selects the inclusive source range; omitting `end` selects one line. `before/after` identifies the destination in the original snapshot. All transfers read original source text, even when another operation replaces or deletes that source in the same batch. Source reads can overlap mutations; a move's deletion and every destination insertion follow the existing mutation-conflict rules. Multiple insertions at the same gap are rejected. A destination strictly inside a moved range is rejected; moving immediately before its first line or after its last line succeeds without changing bytes.

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "copy", "anchor": "10#ABCD", "end": "12#EFGH", "before": "30#JKMN" }
  ]
}
```

Copy the actual tokens from inspection; the example tokens illustrate the shape. Use `move` instead of `copy` to remove the source in the same batch. Transfers retain source text and line separators, preserve the file BOM at byte zero, and do not adjust indentation. A source line without a terminator gains a connector when inserted before another line; new connectors use the file style, except that a line ending in standalone CR needs CRLF to keep that CR as content. A non-empty final line retains the file's original final-newline state. Use body edits when the transferred text or indentation must change.

The TUI edit header shows the total operation count and counts by type, for example `4 ops: replace ×2, delete ×1, append ×1`. During argument streaming, incomplete or unrecognized operation types count as `unknown`; the counts refresh as arguments change.

For multi-operation batches that reach snapshot verification, the rejection lists the fields of the anchors whose checksum matched in `matched`, as zero-based operation and anchor field such as `edits[1].end`; every mismatched anchor appears once, in `failures`. Schema-invalid inputs fail before reading the file and have no `matched`. Single-operation edits omit `matched` and report the failure directly. The bounded list counts omitted entries in `omittedMatched`; an anchor absent from both lists is omitted, not implied matched. A match does not establish range/overlap validity, semantic intent, publication, command success, or validity on a later retry.

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

- Candidates are found by hashing each line’s current content with the **cited** line number; returned anchors use the candidate’s actual line number. `result` is `shifted`, `ambiguous`, or `unresolved`; `search` is `local` or `full-file`. A unique local candidate does not establish uniqueness outside that window.
- A unique candidate gives its new anchor in `candidate` and that line's complete `content` once, without a neighborhood. A row over 4 KiB omits the content in full, stated in `contentOmitted`.
- An ambiguous failure lists `candidates` (and `omittedCandidates`). Their `candidateNeighborhoods` come from the same snapshot, are clipped to file boundaries, merged, and emitted in ascending line order within byte budgets, each with its `lines` range and `rows`. Their rows are observations, not suggested targets; a candidate row already shown there is not repeated in the failure.
- With no candidate, `observed` holds the current cited row as a complete `LINE#HASH│content` observation within the 4 KiB row limit. Oversized and out-of-range rows are reported in `observedOmitted` without content.

The error message names the failed verification step; outcome counts derive from the structured lists. `mutation.publication: "NOT_PUBLISHED"` states that range and overlap rejections wrote nothing too. Each `matched` entry records only a checksum check in that snapshot. The one final `next` covers all anchor failures and survives detail truncation. Every submitted anchor is verified again on retry.

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

Required: non-empty `path`. Optional: positive safe-integer `offset` (1-based; default 1) and `limit` (default 500 lines, set by `read.defaultLimit`). Fractions, zero, negative values, and unknown fields are rejected. Complete anchored rows have the default 256 KiB payload budget (`read.maxKiB`); oversized rows are omitted whole. JSON encoding and metadata add transport overhead beyond that payload budget.

`read` reports `start`, inclusive `end`, `totalLines`, `finalNewline`, `truncated`, `maxBytes`, and `omittedRows`. `nextOffset` identifies continuation after either a line or byte limit; reaching EOF omits it. `oversizedLine` identifies a row that cannot fit. Native image/NUL delegation uses `read.native: true` and preserves the built-in content/images; the native renderer receives that payload without treating it as hashline text.

### Grep

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pattern` | Required | Non-empty string (including whitespace-only text) or array of non-empty strings; arrays match any pattern (OR). When `ignoreCase` is omitted, smart-case is resolved for the entire query, not separately for each array item. |
| `path` | Current directory | Omit `path` to search the working directory. If supplied, it must be one non-empty existing file or directory, or a non-empty array of search roots; `""` and `[]` are invalid. Wildcards are not expanded; use `glob` to filter filenames. |
| `glob` | None | One non-empty glob or a non-empty ordered array; prefix exclusions with `!`. |
| `literal` | Required | `true` matches every pattern as exact text, including regex punctuation such as `pi.on(`; use it for names, paths, and code snippets. It does not force case-sensitive matching. `false` treats every pattern as ripgrep Rust regex, not JavaScript regex: lookaround and backreferences are unsupported, `^`/`$` match at line boundaries, and a valid regex such as `foo(0)` matches `foo0`, not `foo(0)`. An invalid regex fails with `INVALID_REGEX` before any file is searched; `message` is ripgrep's parse error. When the pattern contains lookaround or a backreference, `next` asks to rewrite it without them or use `replace` for JavaScript regex within one file; otherwise it suggests `literal: true`. |
| `ignoreCase` | Smart-case | Query-level case override: `true` ignores case; `false` distinguishes case. Inline regex case flags may override either setting. |
| `multiline` | `false` | Allow matches across physical lines. Valid UTF-8 CRLF is searched as LF; each distinct matched physical line counts toward `limit`. Content mode adds anchors only for valid UTF-8 files. `context` alone does not enable cross-line matching. The `.` wildcard still does not match newlines; use `\n` or `(?s)`. |
| `context` | `0` | Integer from 0 to 20: include that many lines before and after each match (pass 3–5 to inspect code blocks without another read). Fractions are rejected, not rounded. Context lines do not count toward `limit`. |
| `limit` | `100` | Positive safe-integer maximum of distinct matching physical lines, across files and patterns. `search.limitReached` does not prove another match exists. |
| `outputMode` | `"content"` | `"content"` returns matching lines plus context, with anchors for valid UTF-8 or plain line numbers for invalid UTF-8; `"files"` returns distinct paths, and `"count"` returns matching-line counts per file and a total. All modes use the same limited match set: files and counts may be incomplete when the limit or output byte cap is reached. |

The six former grep fields (`matchMode`, `excludePattern`, `wordMatch`, `pcre2`, `follow`, `noIgnore`) are no longer supported. Calls that contain them, including `false` or `null`, fail before searching; saved session history remains readable, but replaying an old call with these fields requires a new query. They are not silently converted to a different search.

Grep defaults to line-based code searches. With `multiline: true`, OR patterns are scanned separately to retain overlapping spans, and matching physical lines are deduplicated before counting. There is no built-in content exclusion, same-line AND, whole-word switch, or PCRE2. Displaying neighboring lines with `context` does not itself match across lines. More specialized searches require another tool (for example, Bash when available); an empty grep result does not establish that ignored files or linked directories contain no matches.

Directory traversal respects ignore rules, does not follow symbolic links, and includes hidden files. Explicitly named files can still be read through a link or from an ignored directory; ordered `glob` filters still apply to explicit file paths. These rules have different priorities for explicit paths and directory traversal and are not simply intersected.

Scope inspection reports `PATH_NOT_FOUND` only for `ENOENT`; wildcard-looking paths select the `glob` recovery. Other traversal errors are `FILESYSTEM_ERROR` with the native failure retained in `causes`.

Searches use bundled ripgrep, independent of system `rg` or `PATH`. The tool disables external ripgrep configuration with `--no-config` and clears `RIPGREP_CONFIG_PATH`, and uses `--no-crlf` and `--encoding=none` so standalone CR and BOM remain content. NUL-containing files are silently skipped in all output modes, including explicitly named files; they do not consume the match limit. Valid UTF-8 files use the shared LF view: files without CRLF are searched at their original paths, and CRLF text is normalized into temporary snapshots using bounded reads and writes. Batches contain up to 64 files or 8 MiB of source data (one large file can exceed that threshold); snapshots are removed after each batch and on failure/cancellation. Match paths refer to original files. Regexes use ripgrep's default Rust-style engine, not PCRE2.

Invalid UTF-8 files without NUL remain searchable as raw bytes. Their queries retain actual CRLF separators; valid UTF-8 files receive the LF-normalized query. Ripgrep’s Unicode regex rules still apply; use a byte-mode group such as `(?-u:...)` to span malformed bytes. Content payloads use replacement characters and plain `LINE│content` rows throughout the file. `search.invalidUtf8Paths` identifies those preview files; their rows cannot serve as edit anchors. Unmatched invalid UTF-8 files produce no warning.

All output modes verify invalid UTF-8 results against the source's pre-search byte revision and the complete raw-byte match spans reported by ripgrep, including the part of a multiline match omitted by `limit`. The tool keeps fixed-size byte digests and verifies them with a bounded scan; different malformed bytes cannot be accepted merely because both display as the same replacement character. Content output retains its complete-file byte revision check for valid UTF-8 as well. A detected mismatch reports `FILE_CHANGED` (`File changed during search.`).

Search diagnostics survive result limits. Confirmed matches return `search.incomplete: true` and a structured `search.diagnostics` collection; counts cover only confirmed matches. With no displayable result, `SEARCH_INCOMPLETE` has the same diagnostic shape in `facts.diagnostics`. Entries distinguish process exit/stderr from file paths and structured causes. [`SearchDiagnosticBuffer`](src/pi/search-diagnostics.ts) retains opening entries and the latest failure within the 4 KiB entry budget, with `omittedEntries`, `omittedCauses`, or `omittedBytes`. Ripgrep stderr and batch aggregation retain their 64 KiB bounds through [`DiagnosticBuffer`](src/pi/diagnostic-buffer.ts). Limits remain in [`budgets.ts`](src/pi/budgets.ts) and [`rg-process.ts`](src/pi/rg-process.ts).

Error cards render the [error record](#reports-and-errors); expanding reveals every retained fact. These display limits do not shorten the tool result sent to the model.

Long lines show a labeled partial preview of up to 500 UTF-16 units near a reported match column when available; context-only lines and matches without a recorded column show their beginning. Labels report 1-based UTF-16 column ranges, and slicing preserves surrogate pairs. The anchor hashes the entire current line, not the preview; use `read` before reconstructing a line from its content.

### Replace

Required: non-empty `path` and a non-empty `replacements` array. Use one item for a single rule; top-level `find`, `replace`, `regex`, and `flags` are not accepted. Each rule requires non-empty `find` and a `replace` string (which may be empty), with these optional fields:

- `regex`: defaults to `false`; both modes match the shared LF view. Regex mode supports capture groups, the full match, and prefix/suffix substitutions.
- `flags`: applies in both modes; `g` is always added. Only `g i m s u y d` characters are accepted; regex syntax errors are reported per rule before the file is read.

Zero matches in any rule (`NO_MATCH`), an invalid rule (`INVALID_ARGUMENTS`), or overlapping match ranges (`OVERLAPPING_MATCHES`) rejects the whole call without writing. Adjacent ranges are allowed. Zero-length matches conflict at the same position or at the start/interior of another match; a zero-length match at another match's end is allowed unless it conflicts with a following match. Error rule indices and string offsets are zero-based (offsets count UTF-16 code units in the original text). Literal and regex rules share the same original ranges for conflict detection.

Regex captures and prefix/suffix substitutions always refer to the original LF-normalized snapshot.
Regex batches run in a worker and are terminated on cancellation (`OPERATION_ABORTED`) or when `replace.regexTimeoutMs` (default 5000 ms) elapses (`REGEX_TIMEOUT`). A cancelled or timed-out batch leaves the file unchanged; literal-only batches retain their existing execution path.

### Write

Required: `path`, `content`, `mode`. Choose `"create"` for a missing target or `"overwrite"` for an existing target; omitting `mode` is rejected before file access or command execution. Content is used exactly as supplied, including an empty string; anchor-looking prefixes are not stripped. Unknown fields, including misspelled modes, are rejected before writing.

- `mode: "create"`: refuse an existing target with `TARGET_EXISTS`.
- `mode: "overwrite"`: require an existing target, otherwise `PATH_NOT_FOUND`.

In both cases `next` names the other mode.

Write results report the write outcome without returning line anchors. Use `read` or content-mode `grep` to obtain anchors for a later `edit`.

Normal write result text omits the revision. Programmatic callers can read `details.publishedRevision`; edit and replace use source revisions internally to reject stale writes.

With Action Fusion enabled, `edit`, `replace`, and `write` also accept `then_run`.

All three mutation tools treat identical final content as a successful no-op: report `no net change`, leave the existing file untouched, and return `publication: "NOT_PUBLISHED"`. A requested `then_run` still runs after freshness checks. Input, anchor, match, target-type, mode, and cancellation checks still apply; edit/replace reject stale source revisions, while zero matches and an existing target in create mode remain errors. Creating a missing empty file is a publication, not a no-op.

### Forget

Forget is disabled by default. Set `"forget": true` in `hashlineEdit` and reload Pi to enable it. While disabled, the extension registers neither the `forget` tool nor its context hooks, and read/grep results carry no result tags. Disabling it does not undo context edits already stored in the session.

`read` results and content-mode `grep` results of at least 2 KiB of text, and image reads, end with a separate `[result rXXXXX]` block. Nested read/grep calls do not return tags because Pi saves only their caller's output. A successful `codemode` result that made a successful read or content-mode grep call receives one tag when the script output meets the same text or image threshold. Its scope notice states that forgetting removes the entire codemode output, including transformed data, conclusions, and other tool results printed by that script. Separate scripts preserve independent forgetting choices. Smaller results, errors, and `files`/`count` grep output carry no tag. `forget` takes `ids` (a non-empty array of distinct tags) and an optional non-empty `note` for conclusions needed in subsequent work. Omit `note` when none are needed; do not restate the read or forget action.

Only results from the step the model has just seen can be forgotten: the tagged results after its previous response. Any other id rejects the whole call with `NOT_FORGETTABLE`, listing the rejected `ids` and the `available` ones. After the response that called `forget` completes, Pi's context edits replace the entire content of each named result with `[Result rXXXXX: content forgotten; rerun the call to see it again.]`. This removes all text and images, including headers, pagination, truncation and search notices, without inspecting their contents. The tool call, the rest of the exchange, and the `forget` call with its `note` stay in context. Save facts you still need in `note` before forgetting. Files, the raw session, and the TUI are unchanged; navigating to a point before the edit restores the original result.

The `forget` card shows the result count in its header, for example `forget · 2 results`, and an optional `note` below it. The shared report renderer displays `forget.ids` once, followed by display-only receipts such as `build.log · lines 100–200`, `photo.png · image`, or `grep /pattern/ · 12 matches in 3 files`. Receipts retain truncation, limit, and incomplete-search annotations. Results without a receipt remain identifiable by the reported ids. Collapsed cards use the shared preview; expansion reveals all retained fields and receipts. Read and grep keep receipts in details, which Pi does not send to the model. The model receives the JSON report with `forget.ids`.

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
run the session's callable Bash tool                             |
(succeeded / failed / timeout / cancelled)                        |
  |                                                               |
  v                                                               |
file unchanged at the end? <--------------------------------------+
  |
  +-- yes --> mutation result (edit/replace include fresh anchors),
  |           then the command outcome
  |
  +-- no ---> mutation result with changed/missing/unknown freshness,
              then the command outcome
```

Once the mutation completes, command failure does not roll it back. `details.report.mutation` and `details.report.command` retain the separate outcomes. A failed command does not set the completed mutation’s report to failure.

The mutation TUI card projects the report’s file facts and diff; the separate command card projects command status, blockers, causes, and native Bash output. A successful report at `post_process` means mutation execution and result generation completed, including no-ops. Publication alone does not mark completion. Later freshness observations update file facts without undoing mutation success. The fused call waits for the command and final observation before returning. RPC hosts receive the same structured reports and choose their layout.

When `then_run.timeout` is supplied, the command card shows the remaining seconds and refreshes once per second even without further command output. The countdown starts with the Bash tool's first execution update, after mutation, queue waiting, and any approval wait. It stops when execution ends; restored unfinished cards show an unknown final status without a countdown. The selected Bash implementation enforces the timeout; an override that emits no progress has no live countdown. Without `timeout`, there is no countdown or implicit time limit. RPC progress includes `timing.timeoutSeconds` and `timing.remainingSeconds` after a timed command starts.

The report contains `command.status` (`skipped`, `succeeded`, `failed`, `timeout`, or `cancelled`) and `command.output`. A command that never starts uses `blockedBy: "mutation"`, `"target"`, `"revision"`, or `"cancellation"`. Revision-read causes belong to `mutation.observationCauses`; command execution causes belong to `command.causes`. Command failure, timeout, and cancellation preserve saved bytes. The final session Bash result includes override and result-hook decisions. Collapsing a card does not shorten model content.

The Fusion queue holds a file from mutation until its command finishes, so another fused call on the same file cannot change it in between. Commands use the session's nested tool dispatcher (`ctx.executeTool("bash", ...)`), including its argument validation, Bash overrides, `tool_call` approval hooks, and `tool_result` hooks. Bash must be callable in that session. If it is unavailable or a hook blocks the command, Fusion reports command failure and retains the completed mutation.

A nested Bash result's `terminate` hint is passed to the parent mutation result so Pi can apply its normal rule for stopping after the tool batch.

## Safety and design

- **Anchors are checksums, not identities.** Each hash combines the 1-based line number and content. Short hashes can collide and do not prove the model observed a line.
- **Validation is local to supplied anchors.** Unrelated in-place changes leave stable anchors usable. A range verifies its supplied start/end anchors, not every interior line.
- **Line shifts change anchors.** Insertions/deletions can invalidate later references. Recovery searches within `shiftRadius`, then the rest of the file if no local candidates match. Unique candidates include bounded line content; ambiguous candidates include neighborhoods for comparison. Use `read` when no candidate is found or needed content is omitted. Retries verify again, without fuzzy matching or automatic relocation.
- **Edits preserve text representation.** `edit` preserves existing line endings, untouched separators, and final-newline state, adding a terminator when needed to represent a final blank line. `edit`/`replace` reject invalid UTF-8 source text; all mutations reject NUL and output that cannot be encoded losslessly as UTF-8. Supplied text (`write` content, `edit` body lines, `replace` replacement text) is checked before the file is read, naming the offending field; the final content is checked again before publication, because a transformation such as a regex without `u` can split a surrogate pair. UTF-16 and legacy code pages are not decoded or preserved; a BOM-free file whose bytes happen to be valid UTF-8 may still be misinterpreted.
- **Fresh anchors depend on the final observation.** After `then_run`, only `unchanged` freshness releases anchors. Without a command, observed and published revisions must agree. Otherwise the report records freshness, omits anchors, and ends with the shared instruction to read before further edits. Later edits still verify anchors.
- **Local queues are not cross-process transactions.** Revision checks bind mutations to the bytes read, but an external writer can still race a check and publication. There is no strict workspace jail or multi-file transaction.

<details>
<summary><strong>Output budgets, byte fidelity, publication, and result-state details</strong></summary>

### Hashing and BOM handling

`read` scans text in bounded chunks, validates the whole file, and retains requested line content within its output budget. It reports the total line count and computes hashes for complete output rows. `grep` scans matching files concurrently, retaining only selected matches/context while formatting each file's output. Completed workers retain formatted output blocks in discovery order. It skips NUL-containing files and generates anchors only for files whose complete contents are valid UTF-8. Invalid UTF-8 previews and anchored output both retain byte revision checks. Mutation revision checks cover actual bytes.

Only confirmed malformed UTF-8 produces `UNSUPPORTED_ENCODING`. Decoder resource failures, including the runtime string-length limit for whole-file `edit`/`replace`, retain their original error instead of being reported as an encoding problem.

File reads compare the opened file and current path's identity, size, and modification/change timestamps before accepting content or reporting a decoding error. An observed concurrent write, truncation, deletion, or replacement reports `FILE_CHANGED` (`File changed during read.`), whose `next` is to retry the call. After a mutation is published, observation reads treat such a change as a changed target instead of a failure and never ask to retry the published mutation. This metadata check does not create an atomic snapshot and cannot detect changes hidden by filesystem timestamp resolution; grep and mutations retain their byte revision checks.

Line boundaries are LF or CRLF; a standalone CR remains line content. Anchored rows display standalone CR as `␍` (U+240D), while hashes use the original content. Edit/replace `details.diff` marks raw CR as `␍`; `details.displayDiff` renders the shared LF view for the TUI, so CRLF boundary markers stay hidden even in mixed-ending files or beside an unterminated last line. Standalone CR and literal `␍` characters remain visible. Unified patches retain the original characters and line endings. The marker is a display aid, not replacement text.

An existing UTF-8 BOM stays at byte zero through first-line replacement/deletion, insertion, copy, or move; deleting all content leaves the BOM. First-line hashes include it. Capturing the first line for copy/move excludes the file-header BOM; interior `U+FEFF` remains content. A copied leading BOM in the first replacement/insertion body line denotes the existing header. BOM-only files retain one anchored line. `replace` can explicitly match the BOM; `write` uses supplied content.

### Output budgets

Payload and fact budgets bound retained content, not file size. JSON escaping and transport metadata are additional bytes unless a budget explicitly bounds the entire serialized report. Whole entries or rows are omitted with counted markers; `next` directs recovery.

| Output | Limit |
| --- | --- |
| `read` | Default 500 rows (`read.defaultLimit`), overridable with `limit`; 256 KiB of anchored text (`read.maxKiB`). No partial anchor rows. An oversized single row directs the caller to inspect chunks with `bash` or make a known text change with `replace`; reducing `limit` cannot split a physical line. |
| `grep` | Default 100 matching lines (`grep.defaultLimit`); partial previews up to 500 UTF-16 units plus row labels. Search diagnostic entries have a separate 4 KiB budget. |
| `forget` tag | With `forget` enabled: direct `read` and content-mode `grep` text results of 2 KiB or more, and image reads. Successful codemode outputs containing a successful read or content-mode grep call use the same threshold and are forgotten as one result; nested results are not tagged. |
| `edit` / `replace` anchors | 16 KiB of complete rows, no fixed row-count limit. `anchors.omitted` counts every row that does not fit; later fitting rows remain available. |
| Error `message` | 4 KiB, preserving the opening and the final cause with an omission notice. |
| Argument errors | 16 KiB for the entire serialized JSON report. Omit the argument copy before whole issues; count both omissions. Each fact/fix has a 4 KiB text budget; preparation causes share a 4 KiB block. Native allowances remain per top-level field. |
| Anchor `failures` | 16 KiB of compact JSON, with no fixed failure-count limit; leading entries are kept whole and the rest counted in `omittedFailures`. Unique candidates include complete rows up to 4 KiB, and ambiguous failures list up to eight candidates each. Unresolved anchors show the current cited row when it fits; oversized or out-of-range rows require a fresh `read` or `grep`. |
| Anchor `matched` | Independent 16 KiB, with no fixed entry-count limit. Omitted entries are counted in `omittedMatched` and are not implied matched. |
| `candidateNeighborhoods` | 16 KiB of complete anchored row text, lowest-line first; no fixed row-count limit. Uses the same first eight candidates per failure as the failure lists. Each listed candidate row is limited to 4 KiB. Rows exceeding either limit are omitted in full and counted in `omittedNeighborhoodRows`; later rows that fit are still returned, with gaps reflected in the `lines` ranges. |
| `forget` `available` ids | 16 KiB; omitted ids are counted in `omittedAvailable`. |
| Cause chains | At most 16 retained entries and a 16 KiB compact-JSON block; argument preparation uses 4 KiB. Depth/branch retain structure, and an omission entry counts unexpanded/omitted branches. |

The fact lists have independent budgets; a record can exceed 16 KiB in total. `next` is outside every budget. Limits apply to the reported record; core failure results retain every input-anchor check.

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
| Non-regular files | Check the opened file handle before reading mutation snapshots or revisions. POSIX FIFO targets, including symlink aliases, are rejected without waiting for a writer. |
| Multiple hard links | Reject existing regular files with multiple links to avoid splitting the link set. |
| Permissions | Copy existing mode bits; new files use `0600`. No separate public permission setting. |
| Post-publication failure | Directory-sync, result-generation, revision observation, or cleanup errors are `POST_PROCESS_FAILED` and retain `PUBLISHED`; unconfirmed publication is `UNKNOWN`. In both cases the record's `next` says not to repeat the change and to read the file first. |
| Durability | Attempt directory synchronization on POSIX, including macOS; tolerate `EINVAL` / `ENOTSUP` from directory fsync and propagate other failures. Windows skips directory synchronization. |
| Cancellation | Every tool reports cancellation as `OPERATION_ABORTED` with the `message` `Operation aborted.`, matching Pi's built-in tools. Mutation records state where it stopped in `stage` and whether the file changed in `publication`. |

### Result and card states

| Field | Meaning |
| --- | --- |
| `mutation.publication` | `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`; never copied into command facts. |
| `mutation.baseRevision` | SHA-256 of source bytes, when available. |
| `mutation.publishedRevision` | SHA-256 of intended published bytes. |
| `mutation.observedRevision` | Commit-layer observation after publication or at the no-op check. Absent when concurrent modification prevents a stable observation. Later Fusion observations update freshness separately. |
| `mutation.freshness` | `unchanged`, `changed`, `missing`, or `unknown`, against the published revision. |
| `mutation.observationCauses` | Native causes of a missing/unreadable revision observation. |
| `command.status` | Final command status; streaming reports also use `waiting` and `running`. |
| `command.blockedBy` | Reference to the mutation, target, revision check, or cancellation that prevented execution. |
| Progress `mutationCompleted` | Derived from successful mutation result generation; used by the TUI alongside optional timeout timing. |

Streaming reports omit anchors. Result-generation failures retain publication; observer failures appear in `progressFailures`. Command output is never mutation diagnostics. Version-1 command-card entries persist only command facts and timing; their native Bash renderer survives reloads without adding model messages. Existing unversioned cards are converted at the persistence boundary, retaining historical reason text as a legacy cause. Restored unfinished commands show an unknown final status.

</details>

## Verification

- `npm run typecheck` checks source, test, and benchmark types in `src/` and `bench/`.
- `npm run format:check` checks formatting in both directories.
- `npm test` runs core and tool tests.
- `npm run test:integration` exercises bundled ripgrep, files over 100 MiB with LF and CRLF text, platform file types, and Action Fusion through real Pi sessions with command failures, cancellation, overrides, and approval/result hooks.
- `npm run bench` measures core throughput and long-line match mapping.
- `node --expose-gc bench/grep-memory.bench.ts` measures grep latency and sampled peak heap/RSS for 24 files totaling 192 MiB, each with one matching line. It creates and removes its fixtures in the system temporary directory.

Both test suites run in a child process without inherited `NODE_OPTIONS`, `NODE_PATH`, or `JITI_*` overrides, and use a temporary Pi agent directory. Extension and worker loading tests copy the locked production dependencies into an isolated installed-package layout; they cannot resolve development dependencies from the checkout.

Real Pi session tests share temporary credentials and settings, disabled resource discovery, and local scripted model responses. They never send provider requests; each feature retains its own tool registration and behavior assertions.

The npm archive integration test runs `npm pack`, extracts the archive beside the locked production dependencies, and loads it with Pi's own jiti loader and virtual modules. It exercises write, read, grep, anchor-based edit, regex replacement in the packaged worker, `then_run`, and forgetting in one real session. It requires npm and tar but does not install packages or contact a model provider.

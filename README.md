# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

English · [简体中文](README.zh-CN.md)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent): line edits cite anchors that are checked against the current file before any write.

The model edits lines by citing anchors from `read` or `grep`. Stale or mistaken edits are rejected with enough context for the model to correct them, instead of silently changing the wrong lines.

## Table of Contents

- [Why use it](#why-use-it)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [When an edit is rejected](#when-an-edit-is-rejected)
- [Action Fusion](#action-fusion)
- [Configuration](#configuration)
- [Output budgets](#output-budgets)
- [Limits](#limits)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why use it

- **Edits land where the model meant.** Each line carries a short `LINE#HASH` anchor. If the file changed since the model looked, the edit is rejected, and the report points to where the line moved.
- **No text matching.** The model never has to reproduce old text exactly, so whitespace drift, duplicate snippets, and long blocks stop causing failed or misplaced edits.
- **Files stay byte-faithful.** BOMs, CRLF/LF line endings, final newlines, and untouched bytes are preserved. Invalid UTF-8 and NUL bytes are rejected before writing.
- **Safe publication.** Writes are atomic (temporary file, then link or rename). Read-modify-write calls bind publication to the bytes they read; failures report whether publication happened.
- **Fewer round trips.** A mutation can carry a follow-up command such as `npm test` ([Action Fusion](#action-fusion)).
- **JavaScript regex everywhere.** `grep` and `replace` use the JavaScript regex semantics the model already knows, with ripgrep speed for finding candidate files.
- **Output sized to the model.** Result sizes scale with the selected model's context window, so small models are not flooded and large models are not starved.

## Install

```bash
pi install npm:@criogaid/pi-hashline-edit
```

Requires Pi 1.5.0 or later. The extension works on local files; for remote or custom storage, set `hashlineEdit.enabled` to `false` and reload Pi to restore the built-in tools.

To locate the workspace during registration, the extension queries the Pi loader's working directory. On Windows it uses Windows Script Host (`cscript.exe`) and falls back to Windows PowerShell if the script cannot return a valid path. On macOS and Linux it uses `/bin/pwd`.

## Usage

Pi's model uses the tools automatically. A `read` returns lines with anchors:

```text
greet.ts · 3 lines
1#ZR63│export function greet() {
2#GFYR│  return "hello";
3#FNSZ│}
```

The model copies an anchor into `edit`:

```json
{
  "path": "greet.ts",
  "steps": [{ "action": "replace", "anchor": "2#GFYR", "lines": ["  return \"hello, hashline\";"] }]
}
```

The edit succeeds only if line 2 still has that content. The TUI shows the diff; the model receives a short JSON report.

The `edit` and `replace` cards use unchanged rows from the mutation to bound the diff. A shared BOM stays with the file, so the first row's copied body can identify a surviving duplicate. A copied last-line body can also identify which duplicate survives when adding or removing its neighbor changes the line terminator. Each changed range aligns up to 128 line additions and deletions combined. If alignment exceeds that limit, the card keeps proven matches and shows the remaining original and replacement rows as blocks.

## Tools

The extension replaces Pi's `read`, `grep`, `edit`, and `write`, and adds `replace`.

| Tool | What it does |
| --- | --- |
| `read` | Shows UTF-8 text with anchors after a header line, paginated within the model's output budget; CRLF shows as LF and standalone CR as `␍`. For a file the model will not edit, `anchors: false` returns the lines alone, without the header or row prefixes, saving about a third of the tokens. Images and files containing NUL bytes go to Pi's built-in read without a Hashline header. |
| `grep` | Searches files and directories with JavaScript regex or literal text; returns anchored matches, file paths, or counts in traversal order; a limit keeps the first matches in that order. Directory searches respect ignore rules except for files and directories a positive `glob` matches, and skip `.git` and linked directories, even beneath a directory named in `path`; naming an ignored file or one of those directories itself searches it. |
| `edit` | Replaces, inserts, or deletes whole lines by anchor. All operations in one call apply to the same snapshot, or none apply. |
| `replace` | Applies literal or regex substitutions across one file. Every rule must match, and overlapping matches reject the batch. |
| `write` | Creates a file (`mode: "create"`) or overwrites one (`mode: "overwrite"`), using the content exactly as given. Missing parent directories are created. |

Scripts that call these tools, such as Pi's codemode, receive each successful result as one object in place of the result text: the fields its report states, preceded for `read` and `grep` by the payload as `text`. The object also has the facts the report leaves out because the payload or the call already shows them: every `grep` result has `matches` and `files`; a `read` that returns at least one line has `nextOffset` whenever lines remain after it, including when the caller's `limit` ends the window (a first line too long to fit returns no line, so the result has `lineTooLong` and no `nextOffset`); and a change whose `then_run` command printed output has it in `then_run.output`. For example, a read cut by its default line limit is `{ text, nextOffset, next }` and a created file is `{ publication }`; reading an image gives Pi's image block, and a file containing NUL bytes gives `{ text }` with Pi's own read output, whose continuation notice is part of that text. A `write`, `edit`, or `replace` whose result equals the file's current content is not a failure: the call resolves with `publication: "NOT_PUBLISHED"`, and nothing is written. A failed call rejects with its report text.

### Paths

File paths accept relative or absolute paths, `~`, an optional leading `@`, and `file://` URLs. On Windows, shell drive paths such as `/c/work/file.txt`, `/mnt/c/work/file.txt`, and `/cygdrive/c/work/file.txt` are also accepted. Relative paths resolve from the workspace directory.

Path input normalizes several Unicode space characters, including U+202F, to ordinary spaces. To address a filename containing a literal Unicode space, pass a percent-encoded file URL, such as `file:///home/me/space%E2%80%AFname.txt` for a name containing U+202F. Paths returned by `read` and `grep`, and the paths a report lists in `missing`, use a spelling that can be passed back to the tools, with `/` as the separator on every platform; keep that spelling, including any URL escapes. The same path syntax applies when `read` delegates images or NUL-containing files to Pi.

### grep

Grep visits input paths in the order supplied and uses ripgrep's sorted directory traversal within each root. Repeated candidate paths are searched once, at their first occurrence. This is not global lexicographic sorting of full paths. A path that does not exist is listed in the report's `missing` (paths beyond the diagnostic block are counted in `omittedMissing`), and the other paths are still searched; the call fails with `PATH_NOT_FOUND` when every path is missing or a missing path contains a wildcard.

Grep matches the LF view (the file's text with CRLF line endings shown as LF) with native JavaScript regexes under the `m` flag; `ignoreCase` adds `i`, and grep takes no other flags. Without `multiline`, each physical line is searched separately; with it, the whole file is searched and every physical line touched by a match is returned. Context rows do not count toward `limit`; when they are shown, a `--` row separates groups of rows that are not adjacent lines of one file. Content output re-reads matched files and omits any whose revision (the SHA-256 of its bytes) changed; `files` and `count` report the searched snapshot without a second read. Incomplete scans state their diagnostics or scan limit in the report.

The grep card preserves file paths and count rows as returned. Only `content` mode formats match rows for display, hiding anchor hashes and folding shared indentation.

### replace

`replace` matches the same LF view, including a leading BOM. When rebuilding the file, it keeps the original BOM at byte zero, even when a match consumes it or inserts before it. A replacement that consumes the file header and starts with a copied BOM reuses that header; explicitly inserted or internal U+FEFF characters remain content. Use `write` to replace the complete byte representation, including the BOM.

### edit

Edit operations:

| `action` | Effect |
| --- | --- |
| `replace` / `delete` | Replace or remove a line, or an inclusive range with `end`. |
| `insert_before` / `insert_after` | Insert lines next to an anchor. |
| `prepend` / `append` | Insert lines at the start or end of the file. |

One call takes at most [64 operations](src/pi/edit-tool.ts). Ranges in one call must not overlap, and each gap between lines takes at most one insertion. An insertion at the start of a replaced or deleted range goes before it.

Range operations verify the cited `anchor` and `end`. Interior lines have no individual anchor check. Changes elsewhere before the call do not invalidate unchanged anchors; publication rechecks the bytes read while applying the call and rejects a detected change.

`edit` preserves a leading UTF-8 BOM. A first-line replacement may copy that BOM without duplicating it; U+FEFF in a prepended or inserted line is content.

An `edit` call puts its small locator first: `path`, `steps`, then optional `then_run`. Each step puts the operation and range before the replacement payload: `action`, `anchor`, optional `end`, then `lines`. This keeps the file and target range visible while arguments stream.

### Arguments

The model sees each tool's full parameter schema; the definitions live in the tool files under [`src/pi/`](src/pi/).

Every tool asks for constrained sampling (Pi's `constrainedSampling`: the provider restricts the model's output to the tool's strict JSON schema) where the provider supports it, so the model cannot emit fields or values the schema does not declare, or exceed edit's operation limit. Optional fields the call does not use are then written as `null`, including each edit operation's fields that its `action` does not take. For the same reason, grep's `pattern`, `path`, and `glob` take arrays only; on other providers Pi wraps a single string into an array.

Pi coerces and validates model arguments. A `tool_call` hook receives those converted values. Its edits must satisfy the tool's schema and operation rules. The tool checks a private snapshot before file access and reports `INVALID_ARGUMENTS` for an invalid edit. Supply operation arrays as declared. Pi drops optional `null` fields before wrapping singleton values into arrays: `replacements: [{ ..., flags: null }]` omits `flags`, while `replacements: { ..., flags: null }` converts it to the string `"null"` and fails flags validation.

## When an edit is rejected

Argument and anchor validation failures leave the file untouched. The report names the error and the fields involved; argument issues carry a per-field `fix`, while anchor failures carry a `next` recovery instruction. For a stale anchor it also shows where the line most likely moved, with its new anchor and nearby lines, so the model can confirm and resubmit without re-reading the whole file. Recovery never edits on its own; every retry is verified again.

A failure during or after publication states `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`. Follow the report's `next` before retrying: an error after publication can leave the requested change on disk.

Argument mistakes, including a reversed range, are reported per field, with what the field means and how to fix it, before any file is touched. A regex syntax error in `grep` or `replace` keeps V8's diagnostic and adds a `fix`: use `literal: true` for exact text, or correct the intended regex. The tool never switches modes automatically.

## Action Fusion

`edit`, `replace`, and `write` accept an optional `then_run` command that runs right after a successful change:

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "literal": true, "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

The command runs through the session's own Bash tool, so approvals, overrides, and hooks still apply. Fusion checks that the change succeeded and the file is still as written before handing the command to the session. It checks the file again after the command settles; an outside writer can still change it while approval is pending or while the command runs. A failing command never rolls back the file. The result shows the model the command's output as plain text, followed by the change's report, whose `then_run` states the command's status. A Bash override that calls a mutation tool for a target already in the Fusion queue receives an error rather than waiting on that queue. The TUI shows the change and the command as separate cards, with a countdown from the effective Bash timeout once Bash reports execution progress.

Cancelling a mutation while it waits in the Fusion queue stops that call before it writes. The earlier mutation and command keep their place in the queue.

Command cards use Pi's native tool component for mouse clicks and the global expand shortcut. Each card keeps its own expansion while output streams or the screen redraws. The built-in Bash renderer displays the command's content, output path, and truncation information. Command cards save these values for session restore. Custom Bash renderer overrides are not exposed by the supported Pi API.

## Configuration

Add `hashlineEdit` to Pi's global settings (`~/.pi/agent/settings.json`) or a project's `.pi/settings.json`:

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "hashLen": 4,
    "shiftRadius": 15,
    "read": { "defaultLimit": 2000 },
    "grep": { "defaultLimit": 100, "defaultContext": 0, "regexTimeoutMs": 5000 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the extension's tools. |
| `actionFusion` | `true` | Allow `then_run` on mutation tools. |
| `hashLen` | `4` | Anchor hash length, 2–8. |
| `shiftRadius` | `15` | Lines searched around a stale anchor before the whole file, 0–100; `0` disables recovery search. |
| `read.defaultLimit` | `2000` | Lines returned when the call gives no limit, matching Pi's built-in read. |
| `read.maxKiB` | Model-based | Fixed cap on read output, 1–4096 KiB. |
| `grep.defaultLimit` | `100` | Matching lines returned when the call gives no limit. |
| `grep.defaultContext` | `0` | Context lines around each match, 0–20. |
| `grep.regexTimeoutMs` / `replace.regexTimeoutMs` | `5000` | Time limit for one regex evaluation, 3000–300000 ms. |

The Pi workspace (the SDK session's `cwd` when embedded) is the base for both `.pi/settings.json` and relative tool paths. A project's `hashlineEdit` replaces the global one as a whole; invalid values fall back to their defaults. Reload Pi after changing settings. `enabled: false` leaves the built-in tools in place; `actionFusion: false` removes `then_run` from new calls but keeps saved command cards visible. The [configuration schema](src/pi/config.ts) is the source of truth.

## Output budgets

The selected model's declared context capacity sets the output budgets; remaining context is never used. A known capacity counts as one byte per context token, up to 4 MiB. Anchored read rows receive a quarter of it and grep payloads an eighth (each at least 512 bytes); a 384,000-token model gets 93.8 KiB per read and 46.9 KiB per grep. Diagnostic blocks receive a quarter of the capacity (at least 512 bytes), and free-text fields a quarter of the block budget (at least 128 bytes). Grep previews keep one UTF-16 code unit per 100 bytes of grep payload and at least 500. A file's first row is narrowed further when it would not otherwise fit the payload after the file's header, and `linePreviewLimit` states the narrowest preview shown. The definitions and fallback values live in [`budgets.ts`](src/pi/budgets.ts).

Argument rejections fit their diagnostic block as serialized JSON. In edit failures, the failure list and the candidate neighborhoods each fit a block in compact JSON, with whole entries or rows omitted and counted; so do replace's list of unmatched rules and the list of missing paths. A `then_run` command's output, as a result gives it to the model and to scripts, follows the free-text field budget; the command card retains the session Bash result.

When model capacity is unknown or invalid, the defaults are 64 KiB for read rows, 50 KiB for grep payloads, 16 KiB per diagnostic block, 4 KiB per free-text field, and 500 UTF-16 code units per grep preview. An explicit `read.maxKiB` overrides only the read cap. Each execution keeps the budget snapshot it started with.

Read reports `nextOffset` when its default line limit or byte budget cuts a window; a caller-supplied `limit` alone does not add a `nextOffset` report. A first row that cannot fit gets a `lineTooLong` byte-limit fact. With `anchors: false`, an `offset` past the last line fails with `OFFSET_PAST_END` and the file's `totalLines`; an empty file read from its first line returns empty text. Grep reports payload and preview truncation separately, and plain previews for invalid UTF-8 never carry edit anchors.

For a truncated grep payload, the report says to retry with `context: 0` only when removing context would fit another matching line in the same byte budget; otherwise it suggests narrowing the search. Inspect full lines before rewriting partial previews: use Bash for paths listed in `invalidUtf8`, and `read` for valid UTF-8.

If the first grep row has no room for a column range, the preview keeps a complete character with ellipses marking omitted text. When only the ellipsis fits, `linePreviewLimit` is zero.

## Limits

- Anchors are short checksums: they catch changed and shifted lines, but can collide and do not prove the model read the line.
- Only UTF-8 text is edited; UTF-16 and legacy code pages are not supported.
- Revision checks catch most concurrent changes, but there is no cross-process lock or multi-file transaction.
- Overwrites keep symlinks pointing at their target. Before publishing, the tool checks that the path still resolves to the same location and that the target is a regular file with only one hard link.
- Grep's [search limits](src/pi/grep-search.ts) allow multiline files up to 64 MiB and individual physical lines up to 64 × 1024² UTF-16 code units. Matching runs in at most four workers, each with a 512 MiB V8 old-generation heap limit; individual regex evaluations use the configured timeout.
- When discovery falls back to every file in scope, it stops queuing files once their combined sizes reach the [256 MiB whole-scope budget](src/pi/grep-candidates.ts); the last queued file can cross that threshold. The report states when this prevents another file from being scanned. Ripgrep protocol records have a [16 MiB limit](src/pi/rg-process.ts), and its stderr is kept to 64 KiB, beginning and end. Unsupported or over-limit candidate analysis widens discovery; JavaScript still decides the matches.

## Development

| Command | Checks |
| --- | --- |
| `npm run format:check` | Formatting. |
| `npm run typecheck` | Types for source, tests, and benchmarks. |
| `npm test` | Core and tool tests. |
| `npm run test:integration` | Real ripgrep, large files, installed packages, and real Pi sessions. |
| `npm run test:all` | Both suites, as in CI. |
| `npm run test:cartesian` | Slow Cartesian regex matrices; run after changing regex translation or prefiltering. |

Result fields and error codes are defined in [`report-schema.ts`](src/pi/report-schema.ts). Module responsibilities are in [`src/core/AGENTS.md`](src/core/AGENTS.md) and [`src/pi/AGENTS.md`](src/pi/AGENTS.md). [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) lists borrowed techniques and test cases.

## Contributing

Questions and bug reports go to [GitHub issues](https://github.com/Criogaid/pi-hashline-edit/issues). Pull requests are welcome: run the checks under [Development](#development) first, and follow the commit conventions in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)

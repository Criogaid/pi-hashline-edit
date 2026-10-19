# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

English · [简体中文](README.zh-CN.md)

Hash-anchored file editing for [Pi](https://github.com/earendil-works/pi-coding-agent). The model edits lines by citing anchors from `read` or `grep`; every anchor is checked against the current file before anything is written. Stale or mistaken edits are rejected with enough context for the model to correct them, instead of silently changing the wrong lines.

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

Requires Pi 0.99.1 or later. The extension works on local files; for remote or custom storage, set `hashlineEdit.enabled` to `false` and reload Pi to restore the built-in tools.

## Quick start

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
  "edits": [{ "op": "replace", "anchor": "2#GFYR", "body": ["  return \"hello, hashline\";"] }]
}
```

The edit succeeds only if line 2 still has that content. The TUI shows the diff; the model receives a short JSON report.

## Tools

The extension replaces Pi's `read`, `grep`, `edit`, and `write`, and adds `replace`.

| Tool | What it does |
| --- | --- |
| `read` | Shows UTF-8 text with anchors, paginated within the model's output budget. Images and files containing NUL bytes go to Pi's built-in read. |
| `grep` | Searches files and directories with JavaScript regex or literal text; returns anchored matches, file paths, or counts in traversal order; a limit keeps the first matches in that order. Respects ignore rules. |
| `edit` | Replaces, inserts, deletes, copies, or moves whole lines by anchor. All operations in one call apply to the same snapshot, or none apply. |
| `replace` | Applies literal or regex substitutions across one file. Every rule must match, and overlapping matches reject the batch. |
| `write` | Creates a file (`mode: "create"`) or overwrites one (`mode: "overwrite"`), using the content exactly as given. |

Grep visits input paths in the order supplied and uses ripgrep's sorted directory traversal within each root. Repeated candidate paths are searched once, at their first occurrence. This is not global lexicographic sorting of full paths.

Grep matches the LF view with native JavaScript regexes. Without `multiline`, each physical line is searched separately; with it, the whole file is searched and every physical line touched by a match is returned. Context rows do not count toward `limit`. Content output re-reads matched files and omits any whose revision changed; `files` and `count` report the searched snapshot without a second read. Incomplete scans state their diagnostics or scan limit in the report.

Edit operations:

| `op` | Effect |
| --- | --- |
| `replace` / `delete` | Replace or remove a line, or an inclusive range with `end`. |
| `insert_before` / `insert_after` | Insert lines next to an anchor. |
| `prepend` / `append` | Insert lines at the start or end of the file. |
| `copy` / `move` | Copy or move a line range to before or after another anchor. |

The model sees each tool's full parameter schema; the definitions live in the tool files under [`src/pi/`](src/pi/).

Range operations verify the cited `anchor` and `end`, plus the destination for copy/move. Interior lines have no individual anchor check. Changes elsewhere before the call do not invalidate unchanged anchors; publication rechecks the bytes read while applying the call and rejects a detected change.

## When an edit is rejected

Argument and anchor validation failures leave the file untouched. The report names the error, the fields involved, and a `next` instruction. For a stale anchor it also shows where the line most likely moved, with its new anchor and nearby lines, so the model can confirm and resubmit without re-reading the whole file. Recovery never edits on its own; every retry is verified again.

A failure during or after publication states `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`. Follow the report's `next` before retrying: an error after publication can leave the requested change on disk.

Argument mistakes are reported per field, with what the field means and how to fix it, before any file is touched.

## Action Fusion

`edit`, `replace`, and `write` accept an optional `then_run` command that runs right after a successful change:

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "literal": true, "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

The command runs through the session's own Bash tool, so approvals, overrides, and hooks still apply. It starts only if the change succeeded and the file is still as written. A failing command never rolls back the file. The TUI shows the change and the command as separate cards, with a live countdown when a timeout is set.

Command cards use Pi's native tool component for mouse clicks and the global expand shortcut. Each card keeps its own expansion while output streams or the screen redraws. The built-in Bash renderer displays the command's original content and details, which are also saved for session restore; custom Bash renderer overrides are not exposed by the supported Pi API.

## Configuration

Add `hashlineEdit` to Pi's global settings (`~/.pi/agent/settings.json`) or a project's `.pi/settings.json`:

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
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
| `enabled` | `true` | Register the extension's tools. |
| `actionFusion` | `true` | Allow `then_run` on mutation tools. |
| `hashLen` | `4` | Anchor hash length, 2–8. |
| `shiftRadius` | `15` | Lines searched around a stale anchor before the whole file, 0–100; `0` disables recovery search. |
| `read.defaultLimit` | `500` | Lines returned when the call gives no limit. |
| `read.maxKiB` | Model-based | Fixed cap on read output, 1–4096 KiB. |
| `grep.defaultLimit` | `100` | Matching lines returned when the call gives no limit. |
| `grep.defaultContext` | `0` | Context lines around each match, 0–20. |
| `grep.regexTimeoutMs` / `replace.regexTimeoutMs` | `5000` | Time limit for one regex evaluation, 3000–300000 ms. |

A project's `hashlineEdit` replaces the global one as a whole; invalid values fall back to their defaults. Reload Pi after changing settings. The [configuration schema](src/pi/config.ts) is the source of truth.

## Output budgets

The selected model's declared context capacity sets the output budgets; remaining context is never used. For a known capacity, anchored read rows and grep payloads receive one byte per context token, up to 4 MiB. Diagnostic blocks receive a quarter of that budget (at least 512 bytes), and free-text fields a quarter of the block budget (at least 128 bytes). Grep previews keep one UTF-16 code unit per four field bytes. The definitions and fallback values live in [`budgets.ts`](src/pi/budgets.ts).

When model capacity is unknown or invalid, the defaults are 256 KiB for read rows, 50 KiB for grep payloads, 16 KiB per diagnostic block, 4 KiB per free-text field, and 500 UTF-16 code units per grep preview. An explicit `read.maxKiB` overrides only the read cap. Each execution keeps the budget snapshot it started with.

Read reports pagination when the extension cuts a window or its byte budget; a caller-supplied `limit` alone does not add a pagination report. A first row that cannot fit gets a `lineTooLong` fact. Grep reports payload and preview truncation separately, and plain previews for invalid UTF-8 never carry edit anchors.

## Limits

- Anchors are short checksums: they catch changed and shifted lines, but can collide and do not prove the model read the line.
- Only UTF-8 text is edited; UTF-16 and legacy code pages are not supported.
- Revision checks catch most concurrent changes, but there is no cross-process lock or multi-file transaction.
- Overwrites keep symlinks pointing at their target; FIFOs, other non-regular files, and files with multiple hard links are not overwritten.
- Grep's [search limits](src/pi/grep-search.ts) allow multiline files up to 64 MiB and individual physical lines up to 64 × 1024² UTF-16 code units. Matching runs in at most four workers, each with a 512 MiB V8 old-generation heap limit; individual regex evaluations use the configured timeout.
- When discovery falls back to every file in scope, it stops queuing files once their combined sizes reach the [256 MiB whole-scope budget](src/pi/grep-candidates.ts); the last queued file can cross that threshold. The report states when this prevents another file from being scanned. Ripgrep protocol records have a [16 MiB limit](src/pi/rg-process.ts). Unsupported or over-limit candidate analysis widens discovery; JavaScript still decides the matches.

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

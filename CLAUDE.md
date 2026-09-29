# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project rules, behavior contracts, verification policy, and commit/release conventions live in AGENTS.md and apply here as well:

@AGENTS.md

## Commands

TypeScript runs directly through Node's type stripping, so there is no build step. CI uses Node 24 and also tests 22.19.0 and 26, on Linux, macOS, and Windows.

- `npm run format:check` / `npm run format` — Biome, formatting only, scoped to `src/`.
- `npm run typecheck` — `tsc --noEmit` over source and tests.
- `npm test` — `node --test src/core/*.test.ts src/pi/*.test.ts`.
- Single file: `node --test src/pi/execute.test.ts`. Single case: add `--test-name-pattern "<regex>"`.
- `npm run test:integration` — bundled ripgrep and files over 100 MiB (slow). `npm run test:all` runs both suites and matches CI and publish.
- `npm run bench`, `node --expose-gc bench/grep-memory.bench.ts` — throughput and grep memory benchmarks.

## Architecture

The extension replaces Pi's built-in `read`, `grep`, `edit`, and `write` tools and adds `replace`. `src/index.ts` loads the config into a `globalThis` singleton (`src/pi/state.ts`). When `enabled` is false it registers nothing. Otherwise it wraps each tool from its `make*Override` / `makeReplaceTool` factory with the Action Fusion executor and render status.

**`src/core/`: pure engine, with no Pi imports.** `hash.ts` computes position-dependent line checksums (line number + content → `LINE#HASH`). `lines.ts` handles splitting and line-ending detection. `text.ts` does strict UTF-8 decoding. `apply.ts` `applyEdits` validates a whole batch of `Edit` ops (see `types.ts`) against a single snapshot: anchor checks, overlap and conflict detection, and shifted-anchor recovery (`AnchorRecovery`: local `shiftRadius` search, then full file). It returns new text or structured failures and never touches the filesystem.

**`src/pi/`: Pi integration.**
- Tool files (`read-tool.ts`, `grep-tool.ts`, `edit-tool.ts`, `replace-tool.ts`, `write-tool.ts`) define TypeBox schemas. `tool-input.ts` `parseToolInput` checks direct `execute` calls against the same schema Pi sees; nothing is normalized or converted. Shared integer rules live in `schema.ts`; error-code strings live in `core/text.ts`.
- `mutation-runner.ts` owns the call sequence shared by `edit`/`replace`/`write`: the `then_run` gate, schema validation, path resolution, `withFileMutationQueue`, and the hand-off to Action Fusion. `runTextMutation` owns the read-modify-write for `edit`/`replace`, so each tool supplies only a `TextChange` (new text, anchors, summary).
- grep is split into `grep-scope` (literal-mode probe, paths, glob admission), `grep-search` (rg events, `GrepBackend`), `grep-output` (formatting and byte budgets), and `grep-render` (TUI). Grep uses ripgrep's Rust regex while replace uses JavaScript `RegExp`; the two dialects are documented, not translated.
- Logical text view: every tool hashes and matches on a CRLF→LF view. Mutations map offsets back to the original bytes so untouched separators, BOM, and final-newline state survive. `rg-text-view.ts`, `text-stream.ts`, and `rg-line-*.ts` do this for grep, which runs bundled `@vscode/ripgrep` and writes LF-normalized temp snapshots for CRLF files.
- `replace` regex batches run in a worker thread (`replace-worker.mjs` bootstraps `replace-worker.ts` through `jiti`, because workers don't inherit Pi's TS loader) with a 5 s timeout. Literal-only batches run in-process (`replace-apply.ts`).
- `file-commit.ts` is the only publication path. It does SHA-256 revisions (`byteRevision`/`fileRevision`), no-op detection, a temp file in a sibling dir, then `link` (create) or `rename` (overwrite). It also handles symlinks and hard links, preserves file modes, and syncs the directory on POSIX. It throws `FileMutationError` with a `stage` and a `NOT_PUBLISHED`/`PUBLISHED`/`UNKNOWN` publication status. `edit`/`replace` pass the revision of the bytes they read as `expectedRevision`.
- `mutation-result.ts` builds diffs and details, the fresh-anchor report (16 KiB budget), and freshness. `failure-context.ts` and `anchor-format.ts` render the bounded anchor-failure diagnostics (candidates, neighborhoods, input-anchor status tables).
- `action-fusion.ts` implements `then_run`. After a successful mutation it checks freshness against `publishedRevision`, then calls Pi's built-in Bash definition directly. The file result and the command result stay separate, and a failed command never rolls back the file. `fusion-card.ts` renders the separate mutation and command TUI cards; `render.ts` holds the tool renderers.
- `config.ts` handles the `hashlineEdit` settings (`enabled`, `actionFusion`, `hashLen` 2–8, `shiftRadius` 0–100).

**Tests:** `*.test.ts` files sit next to their sources. `e2e-scenarios.test.ts`, `failure-path.test.ts`, and `result-safety.test.ts` exercise whole tool flows. `src/integration/` needs the real ripgrep binary and large fixtures.

README.md is the user-facing contract: tool parameters, output budgets, recovery semantics, and publication states. Keep it in sync with behavior changes.

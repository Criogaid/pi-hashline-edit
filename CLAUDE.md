# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project rules, behavior contracts, verification policy, and commit/release conventions live in AGENTS.md and apply here as well:

@AGENTS.md

## Test ownership

Claude works on business code only. Never read, write, or edit test files: `*.test.ts`, `*.testing.ts`, `src/integration/`, or test fixtures. This rule overrides the test-related parts of AGENTS.md and of the sections below.

- When a business-code change breaks or needs tests, do not touch them. Instead, output a self-contained prompt for another model to do the test work: what changed in the source, the new signatures and behavior, what to cover, and how to verify.
- Running `npm run format:check`, `npm run typecheck`, and the test commands to report their results is allowed. When a failure comes from a test file, report it and hand it off through the prompt; do not open the test file to diagnose it.

## Commands

TypeScript runs directly through Node's type stripping, so there is no build step. CI uses Node 24 and also tests 22.19.0 and 26, on Linux, macOS, and Windows.

- `npm run format:check` / `npm run format` — Biome, formatting only, scoped to `src/`.
- `npm run typecheck` — `tsc --noEmit` over source and tests.
- `npm test` — `node --test src/core/*.test.ts src/pi/*.test.ts`.
- Single file: `node --test src/pi/execute.test.ts`. Single case: add `--test-name-pattern "<regex>"`.
- `npm run test:integration` — bundled ripgrep and files over 100 MiB (slow). `npm run test:all` runs both suites and matches CI and publish.
- `npm run bench`, `node --expose-gc bench/grep-memory.bench.ts` — throughput and grep memory benchmarks.

## Architecture

The extension replaces Pi's built-in `read`, `grep`, `edit`, and `write` tools and adds `replace`. `src/index.ts` loads the config once and passes it explicitly to each tool factory, which keeps that snapshot for its lifetime. When `enabled` is false it registers nothing. Otherwise it registers every tool from its `make*Override` / `makeReplaceTool` factory; when `actionFusion` is on, the three mutation tools also receive the Action Fusion executor and are wrapped with `withMutationStatus`.

**`src/core/`: internal pure engine, with no Pi imports and no public API.** It trusts input already filtered by the tool layer and does not re-validate it. `hash.ts` computes position-dependent line checksums (line number + content → `LINE#HASH`). `lines.ts` handles splitting and line-ending detection. `text.ts` does strict UTF-8 decoding. `apply.ts` `applyEdits` validates a whole batch of `Edit` ops (see `types.ts`) against a single snapshot: anchor checks, overlap and conflict detection, and shifted-anchor recovery (`AnchorRecovery`: local `shiftRadius` search, then full file). It returns new text or structured failures and never touches the filesystem. `replace.ts` is replace's engine: literal and JavaScript-regex matching on the LF view, separator restoration, and overlap rejection. `errors.ts` holds the error-code messages and `errorMessage`. `ranges.ts` provides overlap detection for both engines and range merging for grep and failure neighborhoods.

**`src/pi/`: Pi integration.**
- Tool files (`read-tool.ts`, `grep-tool.ts`, `edit-tool.ts`, `replace-tool.ts`, `write-tool.ts`) define TypeBox schemas. Input is filtered once at the top of the funnel: Pi runs the tool's optional `prepareArguments`, then validates against the schema, and only then calls `execute`. `prepareArguments` only rejects what the schema cannot express or cannot name precisely, and never rewrites arguments: edit rejects empty bodies, body lines that cannot be written as UTF-8, line numbers beyond the safe-integer range, and anchors of another hash length; replace rejects unwritable replacement text and compiles regex rules; write rejects unwritable content. `execute` trusts its input and does not re-validate. Tests that probe invalid input go through `callTool` in `tool-call.testing.ts`, which follows the same order. Shared integer rules live in `schema.ts`; error-code strings live in `core/errors.ts`.
- `mutation-runner.ts` owns the call sequence shared by `edit`/`replace`/`write` after Pi has validated the arguments: separating `then_run`, path resolution, `withFileMutationQueue`, and the hand-off to Action Fusion or plain finalization. Each tool's `run` returns a typed `MutationOutcome` (result, commit facts, anchors); nothing downstream reads publication or revisions back from result details. `runTextMutation` owns the read-modify-write for `edit`/`replace`, so each tool supplies only a `TextChange` (new text, anchors, summary).
- grep is split into `grep-tool` (schema and execution order), `grep-scope` (literal-mode decision, paths, glob admission), `grep-search` (`SearchRequest`, `GrepBackend`, rg JSONL events, per-file revisions), `grep-output` (result formatting, file-header format and its parser), and `grep-render` (TUI). `rg-process.ts` is the ripgrep process layer: spawning, bounded reading, shared arguments, and the regex and smart-case probes. `GrepBackend.search` takes a structured request, so scope flags are produced only by `scopeArgs` and never parsed back. Grep uses ripgrep's Rust regex while replace uses JavaScript `RegExp`; the two dialects are documented, not translated.
- Logical text view: every tool hashes and matches on a CRLF→LF view. Mutations map offsets back to the original bytes so untouched separators, BOM, and final-newline state survive. `rg-text-view.ts`, `text-stream.ts`, and `rg-line-ranges.ts` do this for grep, which runs bundled `@vscode/ripgrep` and writes LF-normalized temp snapshots for CRLF files.
- `replace` regex batches run in a worker thread started by `replace-regex.ts` (`replace-worker.mjs` bootstraps `replace-worker.ts` through `jiti`, because workers don't inherit Pi's TS loader) with a configurable timeout (`replace.regexTimeoutMs`, default 5 s). Literal-only batches run in-process. Both paths call the pure engine in `core/replace.ts`.
- `file-commit.ts` is the only publication path. It does SHA-256 revisions (`byteRevision`/`fileRevision`), no-op detection, a temp file in a sibling dir, then `link` (create) or `rename` (overwrite). It also handles symlinks and hard links, preserves file modes, and syncs the directory on POSIX. It throws `FileMutationError` with a `stage` and a `NOT_PUBLISHED`/`PUBLISHED`/`UNKNOWN` publication status. `edit`/`replace` pass the revision of the bytes they read as `expectedRevision`.
- `mutation-result.ts` builds diffs and details and the fresh-anchor report (16 KiB budget), and defines `MutationOutcome`, `commitFreshness`, and `finalizeMutation`, which appends anchors only for a fresh target and otherwise adds the single stale notice (`staleTargetNotice`). `failure-context.ts` renders the bounded anchor-failure diagnostics (candidates, neighborhoods, input-anchor checks); `anchor-format.ts` owns the `LINE#HASH` syntax, its schema pattern, and row parsing.
- `tool-prompts.ts` holds model guidance shared by several tools (`MUTATION_TOOL_GUIDELINE`); text owned by one tool stays beside its schema. `budgets.ts` holds the fixed model-facing output budgets; configurable ones live in the settings schema. `error-text.ts` holds the Pi-layer error forms (cancellation, invalid argument, file changed during search).
- `action-fusion.ts` implements `then_run`. After a successful mutation it checks freshness against `publishedRevision`, then calls Pi's built-in Bash definition directly. The file result and the command result stay separate, and a failed command never rolls back the file. Its own per-file queue wraps mutation and command around Pi's `withFileMutationQueue`; the module header explains the nesting. `fusion-card.ts` renders the separate mutation and command TUI cards (`withMutationStatus`, `registerFusionCards`); `render.ts` holds the shared tool renderers.
- `config.ts` defines the `hashlineEdit` settings as one TypeBox schema (types, bounds, defaults): top-level `enabled`, `actionFusion`, `hashLen`, `shiftRadius` apply to every tool; the `read`, `grep`, and `replace` groups hold tool-specific settings. Invalid leaves fall back to their defaults individually.

**Tests:** `*.test.ts` files sit next to their sources. `registration.test.ts` covers configuration wiring; `read.test.ts` covers reads; `execute.test.ts` covers edits and shared mutation workflows. `failure-path.test.ts` and `result-safety.test.ts` cover publication failures and result safety. `src/integration/` needs the real ripgrep binary and large fixtures.

README.md is the user-facing contract: tool parameters, output budgets, recovery semantics, and publication states. Keep it in sync with behavior changes.

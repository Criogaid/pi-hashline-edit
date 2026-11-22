# Pi Hashline Edit

`@criogaid/pi-hashline-edit` is a Pi extension registered from `src/index.ts`. It replaces Pi's built-in `read`, `grep`, `edit`, and `write` and adds `replace`.

## Where to look

- Read `src/core/AGENTS.md` before changing `src/core/` and `src/pi/AGENTS.md` before changing `src/pi/` or `src/index.ts`. Module responsibilities and each layer's implementation constraints are written only there.
- `src/core/`: the Pi-independent engine (line handling, checksums, decoding, errors, edit, replace, JavaScript search); it has no public API.
- `src/pi/`: tool registration, configuration, argument validation, reporting and rendering, the grep and ripgrep process layers, regex workers, file commit, and Action Fusion.
- `src/integration/`: tests against real backends. `src/testing/`: the test runner, shared test environments, and installation fixtures. `bench/`: benchmarks.
- `docs/` exists only on the maintainer's machine and is git-ignored. `docs/README.md` indexes the research notes there (written in Chinese); `docs/archive/` holds retired material.
- When changing tool parameters, user-visible behavior, or configuration, check the matching contract in `README.md` (tool parameters, output budgets, recovery semantics, publication states).
- When changing Pi API use, lifecycle, or TUI integration, read the documentation and type declarations of the installed Pi version.
- The runtime `typebox` comes from Pi's extension loader (a peer dependency). The `@earendil-works/*` devDependencies and `typebox` are pinned exactly: the Pi packages to one shared version, `typebox` to the version `@earendil-works/pi-coding-agent` depends on. The runtime dependency `@earendil-works/pi-schema` is pinned to that same Pi version, and the compile options in `src/pi/argument-validation.ts` match those of `validateToolArguments` in the installed `@earendil-works/pi-ai`. Upgrade them together.
- For releases, check `.github/workflows/publish.yml` and `package.json`.

## Behavior contracts

- Keep structured JSON edits, pure-function appliers, and batch validation. File mutations reuse `withFileMutationQueue` and the existing commit layer; `src/pi/file-commit.ts` is the only publication path.
- Text edits preserve the BOM, line endings, and untouched bytes. Invalid UTF-8, NUL bytes, and body text that cannot be written losslessly as UTF-8 are rejected before any write. `read` hands supported images to the native tool through Pi's image-detection API, delegates files containing NUL to native `read`, and rejects all other invalid UTF-8.
- Use the shared CRLF-to-LF view for valid UTF-8 in `read/grep/edit/replace`; standalone CR and literal source escapes remain content. Map mutation offsets back to the original bytes; `write` uses the supplied full content and line endings exactly.
- A line hash is a collidable, position-dependent checksum. The caller re-submits recovery candidates for verification; the range-verification boundary is in the README.
- `edit/replace` commits bind to the revision of the bytes actually read. Action Fusion takes the `publishedRevision` returned by the commit layer as its freshness baseline; revisions never appear in tool results.
- Return a successful mutation as one report without anchor rows; keep anchors in read/grep output and edit failure diagnostics. Keep diffs in mutation details for the TUI.
- Give scripts every successful result as one object, declared as the tool's output schema (`SCRIPT_OUTPUT_SCHEMAS`, described in `src/pi/AGENTS.md`). A failure carries no structured content, so a script's call rejects with the report text.
- Keep no compatibility for data saved by older versions (results, reports, and Fusion cards in replayed sessions): a format change is a breaking update, and old data is invalid input. The only exception is input that would crash Pi.
- Publication is reported as `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`, separately from the follow-up command's outcome. That command's output is the result's payload, as plain text ahead of the report, which states only the command's status.

## Coding conventions

- Define each rule, constant, type, or message once; new code reuses existing definitions instead of rewriting them at the call site.
- Inputs go through one argument boundary. It rejects invalid model arguments during preparation and checks the final snapshot because Pi lets `tool_call` hooks modify validated input. Both paths enforce the same schema and semantic rules. Downstream code trusts the filtered input; it does not re-validate, defend, or convert for compatibility. Before adding a defense, confirm that a call path bypassing the upper layer actually exists.
- Business code contains nothing that exists only for tests: an injected parameter, parameter default, optional parameter, function split, `export`, or defense of a call path whose only user is a test is not written. When a test needs a double, it replaces the module with `mock.module()` from `node:test` (for example `rg-process.ts`); `src/testing/run-tests.ts` enables `--experimental-test-module-mocks`.
- Business code has no structure without a production consumer: a wrapper that only forwards to its single caller, a parameter every caller passes the same value, an argument threaded through layers that never read it, a result or `details` field no reader uses, or an `export` that no other business module or benchmark imports. Name the production caller before adding one.
- Derive types from schemas; do not write a separate isomorphic type. Check the invariants of a static table at compile time (`satisfies`, derived types), not with code that runs at module load.
- User-visible limits and numbers share one source with the README; numbers in prompt text are generated from constants, not hard-coded.
- Tools of the same kind share one execution flow; a tool implements only what is unique to it.
- The same kind of failure (cancellation, validation failure) uses one consistent error form.
- Tool results, failures, and model-facing text (descriptions, guidelines, `next`) follow the protocol in `src/pi/AGENTS.md` (Reports and rendering). Outside `src/pi/`, a throw site classifies its failure as a `HashlineError` with a code and the facts that code's schema requires, and a layer returns structured facts, never sentences.
- Model-facing output is exact and deterministic: the same call on the same file state returns the same bytes. Result order, limit cutoffs, and the diagnostic that wins never depend on worker completion order, timing, or iteration over unsorted collections. Resolve a mapping exactly in the extension or reject the call; do not hand the model guesses, offsets to apply, or options to rank, and give each `next` one action. Exact schema facts (a field's choices, the accepted fields) and the recovery candidates of a failed anchor, which the extension verifies again when the model re-submits one, are not guesses.
- Model-visible text (result `content`, tool and field descriptions, snippets, guidelines) is protocol: a change to it is a behavior change, and its tests change in the same commit. Renderer strings are presentation: they may put a report value into words, and never state a fact the report lacks or take a fact from the model text.
- Every tool, parameter, and mode adds schema and description bytes to every call. Add one only for a need that the request or recorded sessions show; remove one that recorded sessions show unneeded.
- Delegate judgments that depend on an external engine's semantics to that engine; do not reimplement or approximate them locally.
- This package is a Pi extension. For anything Pi also does (a renderer, a render-context function, a limit, a wording), use what the installed Pi exports or passes in; where Pi exposes nothing, match the built-in behavior. Differ only for what Hashline adds or the maintainer chose, and record each deliberate difference in `src/pi/AGENTS.md`.
- Fix a defect where the fact is owned. When the same kind of defect reaches a second site (`git log -- <file>` shows earlier fixes of the area), stop patching sites: name the owning schema, module, or layer, change it there, and cover every tool, not only the one that showed the symptom. A suppression, a trimmed duplicate, or a repeated check at the symptom is not a fix.
- A change made for speed or memory carries before-and-after numbers in its commit body, from a repeatable script run on a realistic corpus at the limits callers actually pass; keep the script in `bench/` when it will be run again. Keep the new path only when the numbers pay for its complexity: a cache, prefilter, or translation tier without a stable gain is not added.
- Comments, AGENTS.md files, and READMEs state what is true of the current code, in the present tense, with no change history: no dates, commit ids, or versions, and no contrast with earlier code (`now`, `no longer`, `instead of`). The commit that renames, removes, or changes a symbol, parameter, error code, or rule searches comments, all three AGENTS.md files, and both READMEs for its name and its old behavior and fixes every hit; a comment is deleted with the code it describes. A sentence nobody can check against code or a command is removed.
- AGENTS.md and CLAUDE.md files, business-code comments, and model-visible text are English. `README.md` is English and `README.zh-CN.md` is its Chinese mirror; a change to one updates the other.

## Testing standards

- Each test protects one contract that can be stated outwardly: the README, a behavior contract in AGENTS.md, or a bug that happened. A test that cannot say what it protects is not written.
- Do not use Claude for new model-backed experiments.
- Write each test at the lowest level that can expose the problem: pure `core/` functions first, then the tool layer, and cross-tool flows last. A boundary that `apply.test.ts` can test is not tested through the filesystem in `execute.test.ts`.
- Tool-level tests drive tools through `callTool` in `tool-call.testing.ts` in the production call order, invalid input included.
- Assert behavior and state first: file bytes, returned structure, error codes. Assert only the key part of prompt text. Budgets that vary with the model come from `outputBudgetsFor()` and are not hard-coded; fixed limits the README states (for example the multiline file-size limit and the rg record and stderr limits) are hard-coded in tests to the README's numbers.
- Test one contract once. Use tables for input variants; behavior that `edit` and `replace` share is one shared case run against both tools.
- Render tests assert concrete user-visible content. A case that only checks "does not throw" is not written.
- A bug fix adds one regression test, first confirmed to fail on the old code. A behavior-contract change rewrites the tests that protect the old contract in the same commit instead of leaving CI to find them.
- Probe the boundaries that broke earlier code before calling input handling done, and cover those the code path can reach: empty and maximum-size inputs (an array large enough to overflow a spread call), `null` versus a missing field, U+2028, U+2029, and a lone CR in text, Windows drive roots and command-line length limits, case-insensitive paths, and the file mode a new file gets under the umask.
- Do not write tests for coverage, and do not test private implementation.
- One test fails for one reason; its name reads "condition → behavior".
- Tests that depend on real ripgrep, huge files, or platform differences live in `src/integration/` and stay out of `npm test`, which runs on every commit.

Test layout: `*.test.ts` files sit next to the source they cover; `execute.test.ts` covers edit and the shared mutation flow. `src/testing/session.testing.ts` owns Pi session setup, local model response streams, credential and resource isolation, and cleanup; tool contexts and Fusion sessions share it, while registration and business assertions stay in their own features. `process.testing.ts` provides a clean child-process environment, `installation.testing.ts` creates source or npm-archive installs holding only the locked production dependencies, and `extension-loader.testing.ts` loads them through Pi's jiti and virtual modules. `src/pi/grep-order.test.ts` controls worker and file-read completion order to verify deterministic rows, warnings, and limit cutoffs; `src/integration/grep-order.test.ts` verifies repeated real-rg output and row prefixes as the limit increases.

## Commands

TypeScript runs directly through Node's type stripping, without a build step. CI runs Node 24 on Linux, macOS, and Windows, plus Node 22.19.0 and 26 on Linux. Local formatting, type checks, tests, and benchmarks need no confirmation.

- `npm run format:check` / `npm run format`: Biome, formatting only, over `src/` and `bench/`. To format a change, run `npx biome format --write <files>` on the files it touched instead of `npm run format`, which rewrites every file under both directories, including files outside the change.
- `npm run typecheck`: `tsc --noEmit`, covering source, tests, and benchmarks.
- `npm test`: runs the core and tool tests through `src/testing/run-tests.ts` in an isolated Node environment and a temporary Pi agent directory, excluding inherited Node loaders and personal Pi settings.
- One case: `npm test -- --test-name-pattern "<regex>"`; `npm run test:integration` accepts the same flag. Do not run `node --test` directly; it bypasses the environment isolation.
- `npm run test:integration`: bundled ripgrep, workers from an installed package, files over 100 MiB, and real Pi sessions. `npm run test:all` runs both isolated suites, as CI and the release workflow do.
- `npm run test:cartesian`: runs only the tests named `Cartesian …` (the Cartesian-product matrices) from both suites; they take minutes, and every other command and CI skips them. Run it by hand after changing regex translation, candidate derivation, or prefiltering. A new Cartesian matrix test's name starts with `Cartesian `.
- `npm run bench` and `node --expose-gc bench/grep-memory.bench.ts`: throughput and grep memory. `node bench/argument-validation.bench.ts`: argument preparation plus Pi validation, without executing tools. `node bench/text-stream.bench.ts`: the bounded file scan (UTF-8 validation included) used by read and grep. `node bench/grep-tiers.bench.ts <corpus-dir>... [--reps N]`: grep's candidate tiers against whole-scope V8 checking and a PCRE2 listing ceiling, one fresh process per sample, with each variant's results compared to the tiers'.
- `node --expose-gc bench/mutation-diff.bench.ts <installed-baseline-worktree> [pairs]` measures paired end-to-end edit and replace latency, including diff generation.

Report platform skips in results. Test processes read source from disk; verifying loaded extension behavior through the current Pi session needs the user to `/reload` or restart, so finish the independent checks while waiting. A docs-only change needs only a check of facts, paths, and the diff.

## Commits and releases

- Derive the commit scope from the affected feature or owning module (for example, `grep`, `edit`, `replace`, `file-commit`, `fusion`). For cross-cutting changes, use the narrowest shared capability; never use the package name as scope.
- Commit subjects follow Conventional Commits with an English type and scope and a Chinese description, as in `git log`.
- A commit is one milestone that a single subject describes. A feature or refactor and a bug fix are separate commits, and a speed or memory change is its own commit. When the subject needs `并` or `and` to join two actions, split the commit, unless the second action is only the update the first one forces (a rename and its references). Stage only what belongs to the milestone: other changes in the working tree stay out, and a file that mixes them is split by hunk.
- AI-assisted commits end with `Co-Authored-By: <model name> <email>`; the committing coding agent supplies its own. Claude Code signs with its own model name and `noreply@anthropic.com`. Pi signs with `noreply@pi.dev` and reads the model name from the `PI_MODEL` environment variable before committing; when the variable is unset, it says so instead of guessing a name.
- Commits never include files under `docs/`.
- Push, version, tag, and release actions follow the user's authorization and the actual workflow.
- `.github/workflows/publish.yml` runs when a `v*` tag is pushed: it runs the type check and the full tests, checks that the tag matches the package version, then publishes with npm provenance.

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
- The runtime `typebox` comes from Pi's extension loader (a peer dependency). The `@earendil-works/*` devDependencies and `typebox` are pinned exactly: the Pi packages to one shared version, `typebox` to the version `@earendil-works/pi-coding-agent` depends on. Upgrade them together.
- For releases, check `.github/workflows/publish.yml` and `package.json`.

## Behavior contracts

- Keep structured JSON edits, pure-function appliers, and batch validation. File mutations reuse `withFileMutationQueue` and the existing commit layer; `src/pi/file-commit.ts` is the only publication path.
- Text edits preserve the BOM, line endings, and untouched bytes. Invalid UTF-8, NUL bytes, and body text that cannot be written losslessly as UTF-8 are rejected before any write. `read` hands supported images to the native tool through Pi's image-detection API, delegates files containing NUL to native `read`, and rejects all other invalid UTF-8.
- Classify only Node's confirmed malformed UTF-8 error as `UNSUPPORTED_ENCODING`; preserve other decoder failures and their causes. Streaming validity checks catch only `Utf8DecodingError`.
- In `edit`, an empty body line is a real logical line. When a trailing empty line needs a terminator to be preserved, add one, except for a BOM-only single line. A non-empty last line keeps its original final-newline state.
- Use the shared CRLF-to-LF view for valid UTF-8 in `read/grep/edit/replace`; standalone CR and literal source escapes remain content. Map mutation offsets back to the original bytes; `write` uses the supplied full content and line endings exactly.
- Skip NUL files in grep. Keep invalid UTF-8 output as plain preview rows; matching uses the lossy preview text. Content mode re-reads each matched file and keeps it only when that read has the revision it was matched on; files and count modes report the searched snapshot without re-reading.
- Validate grep patterns and flags with V8 at tool entry; resolve case overrides once into `GrepQuery.flags`. Native `RegExp` in `src/core/search.ts` decides every grep match on the LF view; rg only lists candidates and never decides a match. Candidate derivation may widen but never narrow.
- A line hash is a collidable, position-dependent checksum. The caller re-submits recovery candidates for verification; the range-verification boundary is in the README.
- `edit/replace` commits bind to the revision of the bytes actually read. Action Fusion takes the `publishedRevision` returned by the commit layer as its freshness baseline; revisions never appear in tool results.
- Return a successful mutation as one report without anchor rows; keep anchors in read/grep output and edit failure diagnostics. Keep diffs in mutation details for the TUI.
- Keep no compatibility for data saved by older versions (results, reports, and Fusion cards in replayed sessions): a format change is a breaking update, and old data is invalid input. The only exception is input that would crash Pi.
- Publication is reported as `NOT_PUBLISHED`, `PUBLISHED`, or `UNKNOWN`, separately from the follow-up command's outcome.
- Action Fusion runs the session's Bash through `ctx.executeTool("bash", ...)` and honors overrides and the `tool_call` and `tool_result` hooks. The final session result decides the command's status, and `terminate` is passed on to the parent result; a failed command does not roll back published files.
- The configuration field is `hashlineEdit`. A project's `.pi/settings.json` field replaces the global field as a whole; each setting is validated on its own and falls back to its default when missing or invalid. Types, ranges, and defaults are defined only in the schema in `src/pi/config.ts`. The global path comes from `getAgentDir()`.
- Tools receive the resolved configuration at registration and keep it for their lifetime; changing configuration requires a reload.
- Derive output byte budgets only from the selected model's declared capacity, never remaining context; an explicit `read.maxKiB` overrides only the read cap.

## Coding conventions

- Define each rule, constant, type, or message once; new code reuses existing definitions instead of rewriting them at the call site.
- Give each model-facing rule one home, chosen by what it decides. Choosing a tool, or a parameter of the call being written, belongs in that tool's `description` or the field's description; an obligation spanning several calls belongs in `promptGuidelines`; what to do about one result belongs only in that report's `next` (`src/pi/report-schema.ts`). State a tool's or field's facts once, where they belong. Guidelines never restate a `next`; `NEXT_GUIDELINE`, appended at registration in `src/index.ts`, ranks a report's `next` above them. Word rules as instructions with a concrete trigger and listed exceptions, not as preferences. Include text that applies to one platform only on that platform, decided from `process.platform` where the text is defined.
- Inputs go through a funnel: each tool has one entry point, and invalid input is rejected once at the top level, including checks a schema cannot express. Downstream code trusts the filtered input; it does not re-validate, defend, or convert for compatibility. Before adding a defense, confirm that a call path bypassing the upper layer actually exists.
- Tests drive tools in the production call order; production code keeps no defense for call paths that exist only in tests.
- Business code contains nothing that exists only for tests: an injected parameter, parameter default, optional parameter, function split, or `export` whose only user is a test is not written. When a test needs a double, it replaces the module with `mock.module()` from `node:test` (for example `rg-process.ts`); `src/testing/run-tests.ts` enables `--experimental-test-module-mocks`.
- Derive types from schemas; do not write a separate isomorphic type.
- User-visible limits and numbers share one source with the README; numbers in prompt text are generated from constants, not hard-coded.
- Tools of the same kind share one execution flow; a tool implements only what is unique to it.
- The same kind of failure (cancellation, validation failure) uses one consistent error form.
- Every tool result states its facts in one report (`src/pi/report-schema.ts` defines each field, its owner, and each code's facts and recovery; `src/pi/report.ts` builds and serializes it as one JSON object). A success report follows the content payload; a failure report is the whole `isError` result. Layers return structured facts and never append sentences or bracket notices; each fact has one owner, so it appears once. Throw sites classify failures as `HashlineError` with a code and the facts its schema requires; `message` describes only the throwing step, a failure beneath that step is `cause`; native diagnostics remain directly in `message`, without a synthetic wrapper, except that a missing path or a directory target gets one fixed message in every tool (`PATH_ERROR_MESSAGES`), with resolved paths in `missing`; `next` is derived from the code and publication (a throw site may only select one of the code's named alternatives). Text shared by success and failure (such as `REREAD`) is defined once in the schema module.
- Send the model a result field only when its value changes the model's next call. Do not send a field that is a function of the call's own arguments, or that the same result already states (a payload header, a row, another field). What only a person can act on (diffs, progress, display-callback failures) goes to the TUI through `details`; revisions, candidate strategy, and timing stay out of results. In review, delete a field when nobody can say what the model does differently for another value of it.
- A success report carries `next` only when the result is incomplete or the model would otherwise misread it. A failure's `next` names a tool or parameter whose values the same report supplies; a code with no such action has no `next`. Order `OUTCOME_NEXT` so that following an earlier rule makes a later one reappear on the following call.
- Model-visible text (result `content`, tool and field descriptions, snippets, guidelines) is protocol: a change to it is a behavior change, and its tests change in the same commit. Renderer strings are presentation: they may put a report value into words, and never state a fact the report lacks or take a fact from the model text.
- Delegate judgments that depend on an external engine's semantics to that engine; do not reimplement or approximate them locally.
- AGENTS.md and CLAUDE.md files, business-code comments, and model-visible text are English. `README.md` is English and `README.zh-CN.md` is its Chinese mirror; a change to one updates the other.

## Testing standards

- Each test protects one contract that can be stated outwardly: the README, a behavior contract in AGENTS.md, or a bug that happened. A test that cannot say what it protects is not written.
- Do not use Claude for new model-backed experiments.
- Write each test at the lowest level that can expose the problem: pure `core/` functions first, then the tool layer, and cross-tool flows last. A boundary that `apply.test.ts` can test is not tested through the filesystem in `execute.test.ts`.
- Tool-level tests drive tools through `callTool` in `tool-call.testing.ts` in the production call order, invalid input included; no call path exists for tests that production lacks.
- Assert behavior and state first: file bytes, returned structure, error codes. Assert only the key part of prompt text. Budgets that vary with the model come from `outputBudgetsFor()` and are not hard-coded; fixed limits the README states (for example the multiline file-size limit and the rg record and stderr limits) are hard-coded in tests to the README's numbers, and business modules do not export those constants for tests.
- Test one contract once. Use tables for input variants; behavior that `edit` and `replace` share is one shared case run against both tools.
- Render tests assert concrete user-visible content. A case that only checks "does not throw" is not written.
- A bug fix adds one regression test, first confirmed to fail on the old code. A behavior-contract change rewrites the tests that protect the old contract in the same commit instead of leaving CI to find them.
- Do not write tests for coverage, and do not test private implementation.
- One test fails for one reason; its name reads "condition → behavior".
- Tests that depend on real ripgrep, huge files, or platform differences live in `src/integration/` and stay out of `npm test`, which runs on every commit.

Test layout: `*.test.ts` files sit next to the source. `registration.test.ts` covers configuration wiring, `read.test.ts` covers read, `execute.test.ts` covers edit and the shared mutation flow, `failure-path.test.ts` and `result-safety.test.ts` cover publication failures and result safety, and `argument-validation.test.ts` covers combined-argument failures through the tool entry. `src/testing/session.testing.ts` owns Pi session setup, local model response streams, credential and resource isolation, and cleanup; tool contexts and Fusion sessions share it, while registration and business assertions stay in their own features. `process.testing.ts` provides a clean child-process environment, `installation.testing.ts` creates source or npm-archive installs holding only the locked production dependencies, and `extension-loader.testing.ts` loads them through Pi's jiti and virtual modules; `src/integration/npm-package.test.ts` covers the archive's tool registration, workers, and command dispatch. `src/pi/grep-order.test.ts` controls worker and file-read completion order to verify deterministic rows, warnings, and limit cutoffs; `src/integration/grep-order.test.ts` verifies repeated real-rg output and row prefixes as the limit increases.

## Commands

TypeScript runs directly through Node's type stripping, without a build step. CI runs Node 24 on Linux, macOS, and Windows, plus Node 22.19.0 and 26 on Linux. Local formatting, type checks, tests, and benchmarks need no confirmation.

- `npm run format:check` / `npm run format`: Biome, formatting only, over `src/` and `bench/`.
- `npm run typecheck`: `tsc --noEmit`, covering source, tests, and benchmarks.
- `npm test`: runs the core and tool tests through `src/testing/run-tests.ts` in an isolated Node environment and a temporary Pi agent directory, excluding inherited Node loaders and personal Pi settings.
- One case: `npm test -- --test-name-pattern "<regex>"`; `npm run test:integration` accepts the same flag. Do not run `node --test` directly; it bypasses the environment isolation.
- `npm run test:integration`: bundled ripgrep, workers from an installed package, files over 100 MiB, and real Pi sessions. `npm run test:all` runs both isolated suites, as CI and the release workflow do.
- `npm run test:cartesian`: runs only the tests named `Cartesian …` (the Cartesian-product matrices) from both suites; they take minutes, and every other command and CI skips them. Run it by hand after changing regex translation, candidate derivation, or prefiltering. A new Cartesian matrix test's name starts with `Cartesian `.
- `npm run bench` and `node --expose-gc bench/grep-memory.bench.ts`: throughput and grep memory. `node bench/argument-validation.bench.ts`: argument preparation plus Pi validation, without executing tools. `node bench/text-stream.bench.ts`: the bounded file scan (UTF-8 validation included) used by read and grep.

Report platform skips in results. Test processes read source from disk; verifying loaded extension behavior through the current Pi session needs the user to `/reload` or restart, so finish the independent checks while waiting. A docs-only change needs only a check of facts, paths, and the diff.

## Commits and releases

- Derive the commit scope from the affected feature or owning module (for example, `grep`, `edit`, `replace`, `file-commit`, `fusion`). For cross-cutting changes, use the narrowest shared capability; never use the package name as scope.
- Commit subjects follow Conventional Commits with an English type and scope and a Chinese description, as in `git log`.
- AI-assisted commits end with `Co-Authored-By: <model name> <email>`; the committing coding agent fills in its own name and email (Claude Code uses `noreply@anthropic.com`, Pi uses `noreply@pi.dev`) and does not read them from environment variables.
- Commits never include files under `docs/`.
- Push, version, tag, and release actions follow the user's authorization and the actual workflow.
- `.github/workflows/publish.yml` runs when a `v*` tag is pushed: it runs the type check and the full tests, checks that the tag matches the package version, then publishes with npm provenance.

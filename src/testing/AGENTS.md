# src/testing

These standards apply to every test in the repository, including the `*.test.ts` files next to the source and the tests in `src/integration/`.

- Each test protects one contract that can be stated outwardly: the README, a behavior contract in an AGENTS.md, or a bug that happened. Tests written for coverage or against private implementation are not written.
- Do not use Claude for new model-backed experiments.
- Write each test at the lowest level that can expose the problem: pure `core/` functions first, then the tool layer, and cross-tool flows last. A boundary that `apply.test.ts` can test is not tested through the filesystem in `execute.test.ts`.
- Tool-level tests drive tools through `callTool` in `tool-call.testing.ts` in the production call order, invalid input included.
- Assert behavior and state first: file bytes, returned structure, error codes. Assert only the key part of prompt text. Budgets that vary with the model come from `outputBudgetsFor()` and are not hard-coded; fixed limits the README states (for example the multiline file-size limit and the rg record and stderr limits) are hard-coded in tests to the README's numbers.
- Test one contract once. Use tables for input variants; behavior that `edit` and `replace` share is one shared case run against both tools.
- Render tests assert concrete user-visible content. A case that only checks "does not throw" is not written.
- A bug fix adds one regression test, first confirmed to fail on the old code. A behavior-contract change rewrites the tests that protect the old contract in the same commit instead of leaving CI to find them.
- A test that feeds a downstream module an internal state the argument boundary makes impossible is deleted, or moved to the boundary as an invalid-input case; business code never keeps a defense so that such a test passes.
- Probe the boundaries that broke earlier code before calling input handling done, and cover those the code path can reach: empty and maximum-size inputs (an array large enough to overflow a spread call), `null` versus a missing field, U+2028, U+2029, and a lone CR in text, Windows drive roots and command-line length limits, case-insensitive paths, and the file mode a new file gets under the umask.
- One test fails for one reason; its name reads "condition → behavior".
- Tests that depend on real ripgrep, huge files, or platform differences live in `src/integration/` and stay out of `npm test`, which runs on every commit.

Test layout: `*.test.ts` files sit next to the source they cover; `execute.test.ts` covers edit and the shared mutation flow. In `src/testing/`, `pairwise.testing.ts` builds deterministic 2-way covering arrays for orthogonal multi-axis tables; `session.testing.ts` owns Pi session setup, local model streams, isolation, and cleanup for tool contexts and Fusion sessions; `process.testing.ts` gives a clean child-process environment; `installation.testing.ts` creates source or npm-archive installs with only the locked production dependencies, which `extension-loader.testing.ts` loads through Pi's jiti. `grep-order.test.ts` pins deterministic grep output: the `src/pi/` one controls completion order, the `src/integration/` one repeats real rg.

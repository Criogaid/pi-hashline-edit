# CLAUDE.md

Project rules, architecture routing, commands, and commit conventions live in AGENTS.md and apply here as well. Pi loads only `AGENTS.md` when a directory has both files, so any rule meant for every agent belongs in an AGENTS.md; this file holds only Claude-specific rules.

@AGENTS.md

## Test ownership

These rules bind Claude only; other agents follow the testing sections of AGENTS.md.

Claude works on business code only. Never read, write, or edit test files: `*.test.ts`, `*.testing.ts`, `src/integration/`, `src/testing/`, or test fixtures. This rule overrides the test-related parts of AGENTS.md.

- When a business-code change breaks or needs tests, do not touch them. Instead, output a self-contained prompt for another model to do the test work: what changed in the source, the new signatures and behavior, what to cover, and how to verify.
- Running `npm run format:check`, `npm run typecheck`, and the test commands to report their results is allowed. When a failure comes from a test file, report it and hand it off through the prompt; do not open the test file to diagnose it.

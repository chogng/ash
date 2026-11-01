---
name: unit-tests
description: Use when running unit tests in the Ash repo. Covers pnpm test:unit and its supported arguments for filtering tests by file, glob, and name.
---

# Running Unit Tests

Source-owned unit and component tests run through Mocha. Pure and DOM contract tests use Node/jsdom; rendered component tests use isolated Chromium contexts through `test/unit/browser/context.ts`. The same file filters apply, and the runner builds and serves browser fixtures only when selected tests import that helper. Install the repository-pinned Chromium for these tests. Use the Node version in `.nvmrc` and run these commands from the repository root.

## Scripts

| Scope                                 | Command                 |
| ------------------------------------- | ----------------------- |
| Desktop, extension and architecture units | `pnpm test:unit`        |
| Editor and its Workbench integrations | `pnpm test:editor:unit` |
| Extension host contracts              | `pnpm test:extensions`  |
| Extension package units               | `pnpm test:unit --runGlob 'extensions/*/test/**/*.test.js'` |
| Build tools                           | `pnpm --dir build test` |

The frontend, editor, and extension commands validate filters and select source tests before preparing resources and incrementally compiling the test project. Build-tool tests use Node's test runner and do not accept the Mocha options below. After compiling tests, use `pnpm test:unit:runner` when changing the unit runner; `pnpm test:main` and frontend CI include this regression suite once. Selected business-unit runs do not rerun it.

For repeated runs against unchanged sources and generated inputs, use `pnpm test:unit:no-compile` or `pnpm test:editor:unit:no-compile` with the same filters. These entries reuse `.build/desktop/test`, skip preparation and compilation, and do not rerun the runner's own regression suite. After source, generated input, compiler configuration or dependency changes, use the compiling entry again; `test:unit:prepared` skips generated preparation but still compiles tests. Compilation is incremental and repairs missing or removed outputs.

## Common options

| Option                     | Meaning                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--run <path>`             | A source `.ts` or emitted `.js` path relative to the repository root; starts with `src/`, `extensions/` or `test/`. Repeat for multiple files. |
| `--runGlob <pattern>`      | Match emitted `.js` paths relative to `.build/desktop/test`. Cannot be combined with `--run`.                                   |
| `--affected <base-ref>`    | Local file-level selection since the merge base, including tracked and untracked worktree changes. Cannot be combined with `--run` or `--runGlob`. |
| `--plan`                  | List selected source files and the impact reason without preparation, compilation, output snapshots or test execution; works without compiled outputs. `--grep` is shown but test titles are not collected. |
| `--grep <pattern>`         | Match full Mocha test titles in the selected files.                                                                             |
| `--timeout <milliseconds>` | Positive integer; default 60,000 per test.                                                                                      |
| `--workers <count>`         | Positive integer; defaults to the smaller of 4 and available CPUs. Use 1 for serial execution.                                  |

```bash
pnpm test:unit --run src/ash/workbench/contrib/preferences/test/browser/settings.test.ts --grep 'Models Settings'
pnpm test:unit --runGlob '**/localizationService.test.js'
pnpm test:unit --affected HEAD~1
pnpm test:unit --affected HEAD~1 --plan
```

A single leading package-manager `--` separator is accepted. Unknown options, misplaced separators, empty grep patterns and unmatched file filters fail before preparation. Use `--run` for file paths; bare positional paths and `--coverage` are unsupported. Execution fails if no tests execute, except when `--affected` proves there are no changed inputs or affected files: that exits successfully with an explicit skipped message before preparation. Neither a skip nor `--plan` counts as a test pass. Check the selected suite's final test count and exit code. Runner regression tests have a separate summary.

`--affected` follows imports, including type imports, in both the base and current source graphs. It retains architecture checks and tests with rendered pages, filesystem readers or computed module loads. Markdown documentation outside test/fixture directories does not force a full suite; filesystem readers and architecture checks still cover it. Unknown inputs, package or toolchain changes and affected shared preloads run the complete suite, with a reported reason. Known selections run only their selected files even when larger than half the suite. Use `--plan` to inspect scope before execution. This is a local feedback aid: CI still runs its full suites, and a selected pass does not replace type, integration or smoke validation.

For scope, fixture ownership and cleanup, read [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) and [TypeScript Testing](../../../.github/instructions/typescript-testing.instructions.md). Complete product flows belong in [smoke-tests](../smoke-tests/SKILL.md).

## Preparation failures

For `Unknown translation` errors, match the translation to its source `{ bundle, key }`, run `pnpm localization:check`, and rerun the original test command including preparation.

## Stopping and reusing validation

The runner keeps each file in an isolated Mocha process, rejects `.only`, and prints completed files without interleaving their reporters. Ctrl-C / SIGINT or SIGTERM stops all active children and their descendants and leaves queued files unstarted. Interrupt again to skip the graceful wait. Wait for the actual command to exit before reporting it stopped. Reuse passing results whose inputs still cover the changes; do not rerun tests merely for a commit or push. `test:editor` is an unfiltered combined target; use the individual editor commands for filtering.

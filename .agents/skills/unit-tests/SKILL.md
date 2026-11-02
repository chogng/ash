---
name: unit-tests
description: Run Ash unit tests and collect frontend or Rust code coverage, including file/name filters, source reports and coverage scope.
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
| `--affected <base-ref>`    | Local affected-file selection since the merge base, including tracked and untracked worktree changes. Cannot be combined with `--run` or `--runGlob`. |
| `--plan`                  | List selected source files and the impact reason without preparation, compilation, output snapshots or test execution; works without compiled outputs. `--grep` is shown but test titles are not collected. |
| `--grep <pattern>`         | Match full Mocha test titles in the selected files.                                                                             |
| `--timeout <milliseconds>` | Positive integer; default 60,000 per test.                                                                                      |
| `--workers <count>`         | Positive integer; defaults to the smaller of 4 and available CPUs. Use 1 for serial execution.                                  |
| `--coverage`              | Collect Node and helper-owned Chromium V8 coverage and remap it to TypeScript source. |
| `--coveragePath <directory>` | Write a coverage run to a new directory whose parent exists; refuses existing directories. Defaults to a unique `.build/coverage/frontend-*` directory. |
| `--coverageFormats <formats>` | Comma-separated report formats; repeatable. Supports `html`, `lcov`, `lcovonly`, `json`, `json-summary`, `text`, `text-summary`. Requires `--coverage`. |

```bash
pnpm test:unit --run src/ash/workbench/contrib/preferences/test/browser/settings.test.ts --grep 'Models Settings'
pnpm test:unit --runGlob '**/localizationService.test.js'
pnpm test:unit --affected HEAD~1
pnpm test:unit --affected HEAD~1 --plan
```

A single leading package-manager `--` separator is accepted. Unknown options, misplaced separators, empty grep patterns and unmatched file filters fail before preparation. Use `--run` for file paths; bare positional paths are unsupported. Execution fails if no tests execute, except when `--affected` proves there are no changed inputs or affected files: that exits successfully with an explicit skipped message before preparation. Neither a skip nor `--plan` counts as a test pass. Check the selected suite's final test count and exit code. Runner regression tests have a separate summary.

`--affected` runs analysis in the repository-pinned Bun and follows imports, including type imports, in both the base and current source graphs. For declaration edits with unchanged imports and module initialization, it narrows direct named consumers using local declaration references. Types remain dependencies; namespace imports, side-effect imports, dynamic loads, changed module structure and initialization effects retain file-level propagation. It retains architecture checks and tests with rendered pages, filesystem readers or computed module loads. Markdown documentation outside test/fixture directories does not force a full suite; filesystem readers and architecture checks still cover it. Unknown inputs, package or toolchain changes, affected shared preloads and analyzer failures run the complete suite, with a reported reason. Known selections run only their selected files even when larger than half the suite. Use `--plan` to inspect scope before execution. This is a local feedback aid: CI still runs its full suites, and a selected pass does not replace type, integration or smoke validation.

For scope, fixture ownership and cleanup, read [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) and [TypeScript Testing](../../../.github/instructions/typescript-testing.instructions.md). Complete product flows belong in [smoke-tests](../smoke-tests/SKILL.md).

## Code coverage

```bash
pnpm test:unit --coverage
pnpm test:unit --coverage --run src/ash/base/test/common/numbers.test.ts
pnpm test:editor:unit --coverage
pnpm test:extensions --coverage
just coverage-rust
just coverage-rust --package ash-ansi-escape
```

Frontend coverage uses V8 and c8, merging Node counts with the Chromium pages owned by `useBrowserTests`. The test compiler and coverage-only browser build emit source maps. Reports refer to `.ts` source, include unloaded files under `src/ash` and `extensions`, and exclude tests, fixtures, declarations, dependencies and generated protocol outputs. Independent browser contexts or Workers created outside this helper are not instrumented. `--plan` and an affected-test skip produce no coverage run. Filtered, editor-only and extension-only runs retain their test selection; their percentages are not evidence that the full suite ran.

Default frontend outputs are HTML (`index.html`), LCOV (`lcov.info`), full JSON and `coverage-summary.json`. `run.json` records executed/failed test files, status and Node/browser script counts. Raw/input data is retained for diagnosis. Read the printed run directory, check the exit status and `run.json`, and report line, function and branch coverage separately. Reports generated from failed tests remain failed validation; interruption is not a completed coverage run. Reusing unchanged compiled outputs with `:no-compile --coverage` requires their source maps.

Rust prerequisites are `cargo install cargo-llvm-cov --version 0.9.1 --locked` and `rustup component add llvm-tools-preview` for the pinned toolchain. `just coverage-rust` instruments root-workspace library and binary unit tests through `scripts/cargo.py`, preserving build-input and runtime-host preparation. Each run uses a fresh `.build/coverage/rust-*` target directory and the normal `ci-test` profile. `--package` is repeatable; `--profile`, `--target`, features and jobs are supported, and libtest filters follow `--`. `--coveragePath` selects a new directory instead of the default. No integration tests, doctests, separate Cargo workspaces or frontend execution are included.

Rust writes `html/index.html`, `lcov.info`, LLVM `coverage.json`, `tests.log` and `run.json`. Failed tests still produce a report when LLVM data is available and retain a failing exit code; zero executed tests are not a pass. Stable-toolchain branch coverage is not collected: do not present its empty branch counts as 100%. LLVM regions and Istanbul statements are different metrics; present frontend and Rust summaries separately rather than averaging their percentages or claiming a whole-repository total. Cross-platform code is covered only on the target that actually ran.

## Preparation failures

For `Unknown translation` errors, match the translation to its source `{ bundle, key }`, run `pnpm localization:check`, and rerun the original test command including preparation.

## Stopping and reusing validation

The runner keeps each file in an isolated Mocha process and shares only Node bytecode storage within the run; module instances and globals are fresh for every file. The run removes its cache afterward, respects `NODE_COMPILE_CACHE` / `NODE_DISABLE_COMPILE_CACHE` overrides, and disables caching under `NODE_V8_COVERAGE`. It rejects `.only`, and prints completed files without interleaving their reporters. Ctrl-C / SIGINT or SIGTERM stops all active children and their descendants and leaves queued files unstarted. Interrupt again to skip the graceful wait. Wait for the actual command to exit before reporting it stopped. Reuse passing results whose inputs still cover the changes; do not rerun tests merely for a commit or push. `test:editor` is an unfiltered combined target; use the individual editor commands for filtering.

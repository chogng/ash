---
name: unit-tests
description: Use when running unit tests in the Ash repo. Covers pnpm test:unit and its supported arguments for filtering tests by file, glob, and name.
---

# Running Unit Tests

Unit tests run in Node/jsdom through Mocha. Use the Node version in `.nvmrc` and run these commands from the repository root.

## Scripts

| Scope | Command |
| --- | --- |
| Frontend and architecture units | `pnpm --dir app-ts test:unit` |
| Editor and its Workbench integrations | `pnpm --dir app-ts test:editor:unit` |
| Extension units | `pnpm --dir app-ts test:extensions` |
| Build tools | `pnpm --dir build test` |

The frontend, editor, and extension commands prepare resources and compile tests before running them. Build-tool tests use Node's test runner and do not accept the Mocha options below.

## Common options

| Option | Meaning |
| --- | --- |
| `--run <path>` | A source `.ts` or emitted `.js` path relative to `app-ts`; starts with `src/` or `test/`. Repeat for multiple files. |
| `--runGlob <pattern>` | Match emitted `.js` paths relative to `.build/app-ts/test`. Cannot be combined with `--run`. |
| `--grep <pattern>` | Match full Mocha test titles in the selected files. |
| `--timeout <milliseconds>` | Positive integer; default 60,000 per test. |

```bash
pnpm --dir app-ts test:unit --run src/ash/workbench/contrib/preferences/test/browser/settings.test.ts --grep 'Models Settings'
pnpm --dir app-ts test:unit --runGlob '**/localizationService.test.js'
```

Use `--run` for file paths; bare positional paths and `--coverage` are unsupported. The runner fails if no tests execute. Check the selected suite's final test count and exit code; `test:unit` also runs the runner regression tests, which have their own summary.

For test design and cleanup, read [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) and [TypeScript Testing](../../../.github/instructions/typescript-testing.instructions.md). Real layout and input behavior belong in the Playwright browser integration suite; complete product flows belong in [smoke-tests](../smoke-tests/SKILL.md).

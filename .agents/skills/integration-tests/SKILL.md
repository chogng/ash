---
name: integration-tests
description: Use when running browser integration tests in the Ash repo. Covers pnpm test:browser:integration / test:editor:browser and their supported arguments for filtering tests.
---

# Running Integration Tests

Browser integration tests live in `test/integration/browser/`. They test editors and components in a real browser through Playwright.

## Scripts

| Scope                                 | Command from the repository root |
| ------------------------------------- | -------------------------------- |
| All browser integration specs         | `pnpm test:browser:integration`  |
| Editor browser specs                  | `pnpm test:editor:browser`       |
| Editor units, browser integration and Stanza distribution | `pnpm test:editor`               |

The browser commands typecheck and collect the selection before building pages or starting a server. Unknown options, empty grep patterns, misplaced separators, and zero matches fail before execution. With `--list`, they only typecheck and list tests.

`test:editor` runs the complete editor unit, browser integration and Stanza distribution suites and accepts no filters. Use `test:editor:unit`, `test:editor:browser` or `test:stanza` for targeted validation; the combined command rejects arguments before any suite starts.

## Common options

The runner accepts one leading package-manager `--` separator, but rejects separators between Playwright arguments. Prefer passing arguments directly:

```bash
pnpm test:browser:integration dialog.integration.spec.ts --project=chromium
pnpm test:editor:browser textModel.integration.spec.ts --project=chromium --list
pnpm test:editor:browser --project=chromium --grep 'restores'
```

`--grep`, `--list`, `--repeat-each=N`, and `--max-failures=1` use Playwright's meanings. Check the selected tests with `--list` when a filter is ambiguous. The `chrome-gpu` project selects GPU specs and requires the corresponding Chrome installation; ordinary component specs use `chromium`.

## Distinction from other test types

- Unit tests: [unit-tests](../unit-tests/SKILL.md).
- Browser integration tests: the Playwright commands above.
- Full application flows: [smoke-tests](../smoke-tests/SKILL.md).

## Debugging failures

Repository scripts give each run its own assets, OS-assigned server port, and `.build/desktop/playwright/editor-browser-<id>/` directory. The runner prints its URL and results path; diagnostics and traces are in `results/` and the HTML report is in `report/`. Browser contexts created by a spec must inherit its `baseURL`; do not hardcode port 5185. Direct Playwright config launches retain the default `editor-results` and `editor-report` paths. Inspect state, DOM, logs, and traces when a test fails. Follow [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) for fixture ownership and cleanup.

## Stopping and reusing validation

Send Ctrl-C / SIGINT or SIGTERM to the runner. It stops scheduling, permits bounded teardown, then cleans the owned process tree; interrupt again to skip the wait. Wait for command exit before reporting cleanup. Reuse successful validation when its inputs cover the current changes; a commit or push does not require another run.

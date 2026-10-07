---
name: integration-tests
description: Use when running browser integration tests in the Ash repo. Covers pnpm test:browser:integration / test:editor:browser and their supported arguments for filtering tests.
---

# Running Integration Tests

Browser integration tests live in `test/integration/browser/`. They test editors and components in a real browser through Playwright.

## Scripts

| Scope | Command from the repository root |
| --- | --- |
| All browser integration specs | `pnpm test:browser:integration` |
| Editor browser specs | `pnpm test:editor:browser` |
| Editor units plus browser integration | `pnpm test:editor` |

These commands typecheck the tests, build the browser pages, start the test server, and close it when Playwright exits. With `--list`, they only typecheck and list tests.

## Common options

Arguments go directly to Playwright; do not add a `--` separator:

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

Diagnostics and traces are under `.build/desktop/playwright/editor-results`; the HTML report is under `editor-report`. Inspect state, DOM, logs, and traces when a test fails. Follow [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) for fixture ownership and cleanup.

---
description: Ash TypeScript test writing guidelines — unit tests, browser integration, snapshots, and clean teardown.
applyTo: "**/src/ash/**/test/**/*.ts,**/src/ash/**/*.test.ts,test/**/*.ts"
---

# Writing Tests

## Test Types

| Type | File suffix | Location | Runs in |
| --- | --- | --- | --- |
| Unit tests | `.test.ts` | `src/ash/**/test/` | Mocha in Node/jsdom |
| Browser integration tests | `.integration.spec.ts` | `test/integration/browser/` | Chromium via Playwright |
| Smoke tests | `.spec.ts` | `test/smoke/areas/` | Browser or Electron via Playwright |

Test sorting and serialization in unit tests, real layout and input in browser integration, and startup, IPC, backend persistence and restart in smoke tests. Keep a real product flow when moving detailed rule coverage to unit tests.

## Running Tests

- Unit: `pnpm test:unit`, filtered with `--grep <pattern>`, `--run src/ash/<owner>/test/<runtime>/myFile.test.ts`, or `--runGlob '**/myFile.test.js'`.
- Editor browser integration: `pnpm test:editor:browser`.
- Browser integration: `pnpm test:browser:integration`.
- Browser and Electron UI: the owning `test:smoke:*` Playwright project.

## Unit tests and fixtures

- Use Mocha's TDD interface (`suite`/`test`), explicitly imported functions, and `node:assert/strict`.
- Compare the complete result when that value is the behavior.
- Inject dependencies instead of stubbing them on `globalThis`.
- Service assembly tests exercise production creation and reject missing required registrations. Command tests execute the command and assert its effect.
- Register and dispose listeners, timers, transports and models through the production lifecycle. Use `using` for synchronous ownership and `try`/`finally` for asynchronous cleanup; restore test-owned mocks and globals in that test. File-level resources use `suiteTeardown`.
- Drive timers with a controlled clock and wait for observable state or events; do not use fixed sleeps for readiness.

For DOM constructors needed during module loading, use `src/ash/editor/test/browser/testEditorDom.ts`. A different set of globals uses `installEditorTestDom` with an explicit constructor list; restore globals and close the DOM in teardown. Keep behavior-specific mocks in the test.

## Product automation

- Import `test/automation/test.ts` and reuse the owning window and feature drivers. Each scenario gets fresh workspace/profile state; a restart retains that scenario's state. The launcher owns readiness, cleanup and diagnostics for all windows, including startup failures.
- After an action reorders a list, locate the target by stable identity; a live `.first()` may identify a different item. Keep catalog rules in unit tests and verify persistence with a named item in the product flow.
- When changing automation facilities, verify fault injection reached the intended boundary, assert the exact deliberate error before expecting teardown failure, and exercise state isolation and cleanup through real launches.
- Filtered runs must execute tests; zero matches cannot count as successful validation.

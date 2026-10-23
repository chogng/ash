---
description: Ash test writing guidelines — unit tests, integration tests, snapshot tests, and clean teardown patterns. Reference when writing or updating tests.
applyTo: "src/ash/**/test/**/*.ts, src/ash/**/*.test.ts,extensions/**/test/**/*.ts,test/**/*.ts"
---

# Writing Tests

## Test Types

| Type | File suffix | Location | Runs in |
| --- | --- | --- | --- |
| Unit and component tests | `.test.ts` | `src/ash/<owner>/test/<runtime>/` | Mocha; Node/jsdom or isolated Chromium pages |
| Extension package unit tests | `.test.ts` | `extensions/<owner>/test/<runtime>/` | Mocha in Node/jsdom |
| Browser integration tests | `.integration.spec.ts` | `test/integration/browser/` | Chromium via Playwright |
| Stanza distribution tests | `.spec.ts` | `test/stanza/` | Chromium and Firefox against the standalone build |
| Smoke tests | `.spec.ts` | `test/smoke/areas/` | Browser or Electron via Playwright |

## Test scope

- Keep rules, rendered components and renderer service assembly in the owning source module's `.test.ts`. Reuse existing coverage before moving assertions. For real layout, styles, focus and input, use `useBrowserTests` from `test/unit/browser/context.ts` inside a Mocha `suite`; `test:unit` prepares the shared browser assets only when selected files need them. Use normal Mocha hooks and tests, with Playwright only driving and asserting against the browser.
- Browser page fixtures live with their component under `test/<runtime>/fixtures/`; genuinely shared pages and helpers live in `test/fixtures/browser`. Name executable page harnesses `.page.ts`: `.fixture.ts` is reserved for screenshot fixture discovery. Keep spec-only helpers out of production modules.
- Root browser integration covers real process/package loading, transport, Worker or iframe boundaries, native browser contracts and representative host lifecycles. Split mixed suites by the boundary each case observes; multiple renderer services and mocked IPC alone do not require a root integration suite.
- Do not add a full-application smoke test solely to check icon size, color, spacing or corner radius. Keep these checks automated with computed CSS and rendered geometry assertions; a screenshot alone does not replace those assertions.
- Use smoke tests for startup, IPC, native windows, real filesystem or process wiring, backend persistence and restart, and representative complete user flows. Keep smoke coverage for layout or interaction that depends on actual Workbench or native-window composition and cannot be exercised in an isolated component.
- When moving coverage, map the old behavior and assertions to the destination, pass the destination tests before removing the old cases, and retain the affected real product flow. Remove an existing duplicate only after confirming equivalent coverage; merely checking that a retired button is absent does not prove a feature works.

## Running Tests

- Unit: `pnpm test:unit`, filtered with `--grep <pattern>`, `--run src/ash/<owner>/test/<runtime>/myFile.test.ts`, or `--runGlob '**/myFile.test.js'`.
- Editor browser integration: `pnpm test:editor:browser` covers Stanza and its Code/file host adapters. Extension clients such as Academy, PDF Viewer and Reference Manager use `pnpm test:browser:integration <spec>`; their acceptance belongs to the extension or document host.
- Stanza distribution: `pnpm test:stanza`; see `test/stanza/README.md` for prepared builds and diagnostics.
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

---
description: Ash TypeScript test writing guidelines — unit tests, browser integration, snapshots, and clean teardown.
applyTo: "**/src/ash/**/test/**/*.ts,**/src/ash/**/*.test.ts,test/**/*.ts"
---

# Writing Tests

Canonical reference: https://github.com/microsoft/vscode/wiki/Writing-Tests

## Test Types

| Type | File suffix | Location | Runs in |
|------|-------------|----------|---------|
| Unit tests | `.test.ts` | `src/ash/**/test/` | Mocha in Node/jsdom |
| Browser integration tests | `.integration.spec.ts` | `test/integration/browser/` | Chromium via Playwright |
| Smoke tests | `.spec.ts` | `test/smoke/areas/` | Browser or Electron via Playwright |

Choose the smallest layer that owns the behavior. Keep sorting and serialization rules in unit tests, real component layout/input in browser integration, and startup, IPC, backend persistence and restart in smoke tests. Preserve a real product flow when moving detailed rule coverage down a layer.

## Running Tests

- **Unit tests:** `pnpm test:unit`
  - Filter: `--grep <pattern>`
  - File: `--run src/ash/<owner>/test/<runtime>/myFile.test.ts`
  - Glob: `--runGlob '**/myFile.test.js'`
- **Editor browser integration:** `pnpm test:editor:browser`
- **All browser integration:** `pnpm test:browser:integration`
- **Browser and Electron UI:** use the owning `test:smoke:*` Playwright project.

## Writing Unit Tests

Tests use Mocha's TDD interface (`suite`/`test`) with `node:assert/strict`. Import Mocha functions explicitly; use injected test doubles for dependencies.

## Writing Product Automation

Import the shared fixture from `test/automation/test.ts`. Reuse the owning window and feature drivers for repeated navigation; keep behavior assertions in the scenario. A new scenario owns fresh workspace/profile state, while a restart retains that scenario's state. The launcher owns startup readiness, process cleanup and diagnostics for all its windows, including failures before startup completes.

When an action reorders a list, retain the target's stable identity in the locator. A live `.first()` locator can point to a different item after the action and make the assertion check the wrong behavior. Keep catalog rules in the owning unit suite and verify persistence with a named item in the product flow.

When changing these facilities, verify their failure behavior: confirm fault injection reached the intended boundary, assert the exact deliberately emitted error before expecting teardown to fail, and exercise state isolation and cleanup through real launches. Confirm that filtered runs execute tests; zero matched tests must not produce a successful validation result.

## Unit Fixtures

Editor unit tests that need DOM constructors while modules load should use `src/ash/editor/test/browser/testEditorDom.ts` when its browser setup matches the test. When a test needs a different set of globals, use `installEditorTestDom` with an explicit constructor list and keep behavior-specific mocks in that test; restore the globals and close its DOM in teardown. Put behavior that depends on real browser layout or input in a Playwright browser integration test.

### Clean Teardown

Keep disposables with the test that creates them. Use `using` for synchronous ownership and `try`/`finally` for asynchronous cleanup:

```typescript
import { suite, test } from 'mocha';

suite('MyComponent', () => {
	test('releases its listener', () => {
		using component = new MyComponent();
		// Assert the behavior and lifecycle contract.
	});
});
```

Restore any test-owned mock or global change in the same test. File-level resources use Mocha's `suiteTeardown` and must be released before the test file finishes.

### Best Practices

- Minimize assertions per test — prefer one `assert.deepStrictEqual` snapshot over many fine-grained assertions
- Don't add tests to the wrong suite — find the relevant `suite` block
- Follow `suite`/`test` consistently within a file
- Drive timers with a controlled clock and wait for observable state or events; do not use a fixed sleep as a readiness check
- Inject product dependencies instead of stubbing them on `globalThis`; use the editor DOM fixture above only for browser constructors and capabilities

### Snapshot Testing

When an existing snapshot baseline covers the behavior, update it in the same change and review the diff. Otherwise assert the owned behavior directly.

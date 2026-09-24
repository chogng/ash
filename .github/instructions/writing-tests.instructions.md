---
description: Ash TypeScript test writing guidelines — unit tests, browser integration, snapshots, and clean teardown.
applyTo: "**/src/ash/**/test/**/*.ts,**/src/ash/**/*.test.ts,app-ts/test/**/*.ts"
---

# Writing Tests

Canonical reference: https://github.com/microsoft/vscode/wiki/Writing-Tests

## Test Types

| Type | File suffix | Location | Runs in |
|------|-------------|----------|---------|
| Unit tests | `.test.ts` | `src/ash/**/test/` | Mocha in Node/jsdom |
| Browser integration tests | `.integration.spec.ts` | `test/integration/browser/` | Chromium via Playwright |
| Smoke tests | `.spec.ts` | `test/smoke/areas/` | Browser or Electron via Playwright |

## Running Tests

- **Unit tests:** `pnpm --dir app-ts test:unit`
  - Filter: `--grep <pattern>`
  - File: `--run src/ash/<owner>/test/<runtime>/myFile.test.ts`
  - Glob: `--runGlob '**/myFile.test.js'`
- **Editor browser integration:** `pnpm --dir app-ts test:editor:browser`
- **Browser and Electron UI:** use the owning `test:smoke:*` Playwright project.

## Writing Unit Tests

Tests use Mocha's TDD interface (`suite`/`test`) with `node:assert/strict`. Import Mocha functions explicitly; use injected test doubles for dependencies.

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
- Don't stub globals (e.g., `(mainWindow as any).X = ...`) — make dependencies injectable instead

### Snapshot Testing

When an existing snapshot baseline covers the behavior, update it in the same change and review the diff. Otherwise assert the owned behavior directly.

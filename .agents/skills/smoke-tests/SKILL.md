---
name: smoke-tests
description: Use when running Ash smoke tests or working on smoke-test CI steps. Covers pnpm run smoketest / smoketest-no-compile, grep filtering tests, and a temporary repeat-loop technique for tracking down flaky smoke tests in CI.
---

# Running Smoke Tests

Smoke tests live in `test/smoke/` and drive a full Ash instance (Electron or web, or remote) through end-to-end user flows.

## Scripts

Run from the repository root:

- `pnpm run smoketest` — prepares Desktop and the App Server, checks automation types, then runs the connected Electron suite.
- `pnpm run smoketest-no-compile` — runs the connected Electron suite against the prepared build. CI uses this after preparing or restoring the build.

Both forward extra arguments to `test/smoke/run.ts` and Playwright; no `--` separator is needed.

For a specific target:

| Target | Prepare and run | Run after preparation |
| --- | --- | --- |
| Electron UI | `pnpm run test:smoke:ui` | `pnpm run test:smoke:ui:no-compile` |
| Electron with App Server | `pnpm run smoketest` | `pnpm run smoketest-no-compile` |
| Browser UI | `pnpm run test:smoke:browser` | `pnpm run test:smoke:browser:no-compile` |
| Browser with App Server | `pnpm run test:smoke:browser:full` | `pnpm run test:smoke:browser:full:no-compile` |

The regular commands run their matching `pretest:smoke:*` preparation first. The `no-compile` commands require that preparation to have completed against the current source. CI runs preparation and execution as separate steps so a temporary repeat loop can rerun tests without rebuilding on every iteration. Extra arguments after the script name go to Playwright; no `--` separator is needed.

## Common options

| Option | Description |
| --- | --- |
| `test/smoke/areas/<area>/<file>.spec.ts` | Select one spec file. |
| `--grep "<pattern>"` | Filter Playwright test titles. |
| `--list` | Show selected tests without running them. |
| `--repeat-each=N` | Repeat every selected test N times in one run. |
| `--max-failures=1` | Stop after the first failed test. |
| `--shard=N/M` | Run one file-level partition of the suite. CI uses four independent runners per Electron suite and OS with one worker each; UI and connected suites run in parallel. |

```bash
# Prepare and run the Browser UI suite
pnpm run test:smoke:browser

# Select a spec and check its tests before running
pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/home.spec.ts --list

# Run only tests whose titles match a pattern
pnpm run smoketest --grep "<test title>"
```

A grep pattern can select more than one test. Check the selected list when the title is not unique. The runner exits nonzero if a selected test fails.

## Temporarily loop a test to reproduce a CI failure

For an intermittent failure that appears only in CI, run the affected test repeatedly in the failing CI environment and stop on the first failure. This is a temporary diagnostic change, not a permanent CI step.

1. Identify the failing surface, suite, shard and test title from the job log. `.github/workflows/frontend.yml` calls `frontend-tests.yml` for Linux Browser and Windows/macOS Electron. Each Electron platform builds once and transfers the current build to separate UI and App Server-connected suites, each with four independent file shards.
2. On a temporary branch, keep the existing preparation step. Replace the matching smoke test step with a loop over its `no-compile` command. The example below replaces the Electron UI step; use `pnpm run test:smoke:browser:no-compile` for Browser UI.
3. Increase the job's `timeout-minutes` if the selected test needs more time for all iterations. Keep the existing failure artifact upload step.
4. Fix the failure, then remove the loop and restore the normal CI command and timeout before merging.

```yaml
# TEMPORARY: replace the Electron UI test step while investigating a CI-only failure.
- name: Test Electron UI
  run: |
    for i in $(seq 1 20); do
      echo "::group::Smoke probe run $i/20"
      pnpm run test:smoke:ui:no-compile --grep "<test title>" --max-failures=1 || { echo "::error::Smoke test failed on run $i/20"; exit 1; }
      echo "::endgroup::"
    done
```

The first failure is enough to reproduce the problem. Stopping there preserves its diagnostics and avoids spending CI time on further runs.

## Debugging CI smoke failures

Start with the failing test and error in the GitHub Actions job log. The workflow uploads `.build/desktop/playwright/` on failure as `frontend-electron-<runner>-<suite>-<shard>` or `frontend-browser-<runner>-1`; use the exact name in the failing job. The run ID appears in the Actions run URL. Download the artifact for the failing suite and shard:

```bash
gh run download <run-id> -n frontend-electron-windows-latest-ui-2 -D ./logs
```

The artifact contains `test-results/` and, when generated, `report/`. A failed test that reaches the Workbench fixture attaches `trace.zip` under its test result. Inspect the error and trace to find the failing action, then run that test locally with the same target and filter. If it fails only in CI, use the temporary loop above. `frontend-build-<runner>` is the separate one-day artifact consumed by Electron shards, not test diagnostics.

## Distinction from other test types

- Unit tests: `pnpm test:unit`.
- Editor browser integration tests: `pnpm test:editor:browser`.
- Smoke tests: the Playwright scripts above.

## Changing tests

Read [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) for shared fixtures, assertions, readiness, isolation, and cleanup. Reuse `test/automation/test.ts`, `workbench.settingsEditor`, and `workbench.openAgentsWindow(target.kind)` for setup and navigation.

For Sessions restoration, use `workbench.reopenAgentsWindow(application, page)`: web reloads the page; Electron closes and reopens the window with the same profile so asynchronous saves complete. For system-menu assertions, use `captureElectronMenu` from `electronDriver.ts` and trigger the real UI action.

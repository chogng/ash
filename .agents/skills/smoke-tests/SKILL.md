---
name: smoke-tests
description: Use when running Ash smoke tests or working on smoke-test CI steps. Covers pnpm run smoketest / smoketest-no-compile, grep filtering tests, and a temporary repeat-loop technique for tracking down flaky smoke tests in CI.
---

# Running Smoke Tests

Smoke tests live in `test/smoke/` and drive a full Ash instance (Electron or web, or remote) through end-to-end user flows.

## Scripts

Run from the repository root:

- `pnpm run smoketest` — prepares the backend, builds Desktop, typechecks the automation, then runs the Electron App Server project.
- `pnpm run smoketest-no-compile` — runs that project against existing preparation. CI uses this after an explicit preparation step.

The smoke commands use `test/smoke/run.ts` and Playwright. Pass file filters and options directly after the script name, without `--`. The runner accepts one leading npm-style separator for compatibility, but rejects separators between Playwright arguments: Playwright excludes everything after `--` from test selection.

For a specific target:

| Target                   | Prepare and run                    | Run after preparation                         |
| ------------------------ | ---------------------------------- | --------------------------------------------- |
| Electron UI              | `pnpm run test:smoke:ui`           | `pnpm run test:smoke:ui:no-compile`           |
| Electron with App Server | `pnpm run smoketest`               | `pnpm run smoketest-no-compile`               |
| Browser UI               | `pnpm run test:smoke:browser`      | `pnpm run test:smoke:browser:no-compile`      |
| Browser with App Server  | `pnpm run test:smoke:browser:full` | `pnpm run test:smoke:browser:full:no-compile` |

The regular commands run their matching `pretest:smoke:*` preparation first. The `no-compile` commands require that preparation to have completed against the current source. Reuse valid preparation instead of rebuilding for another targeted run. CI runs preparation and execution separately.

## Common options

| Option                                   | Description                                    |
| ---------------------------------------- | ---------------------------------------------- |
| `test/smoke/areas/<area>/<file>.spec.ts` | Select one spec file.                          |
| `--grep "<pattern>"`                     | Filter Playwright test titles.                 |
| `--list`                                 | Show selected tests without running them.      |
| `--repeat-each=N`                        | Repeat every selected test N times in one run. |
| `--max-failures=1`                       | Stop after the first failed test.              |

```bash
# Prepare and run the Browser UI suite
pnpm run test:smoke:browser

# Select a spec and check its tests before running
pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/home.spec.ts --list

# Run only tests whose titles match a pattern
pnpm run smoketest --grep "<test title>"
```

A grep pattern can select more than one test. Check the selected list when the title is not unique. Before launching product processes, the runner collects tests and prints the selected count. Invalid options, empty grep patterns, misplaced separators, and zero matches fail; they must never trigger a fallback to the full suite. An unfiltered command intentionally selects the entire owning project. The runner exits nonzero if a selected test fails.

Use `--debug` for interactive debugging. The runner rejects Playwright's `--ui` mode because it bypasses the collection-only preflight.

## Stopping a run

Send Ctrl-C / SIGINT or SIGTERM to the actual runner command. It stops scheduling and allows up to 45 seconds for Playwright teardown; interrupt again to skip that wait. It force-terminates surviving workers and product process trees, confirms their exit, then stops registered test-owned App Server profiles so clients cannot restart them. Electron processes and managed daemons use separate process groups, so killing only a wrapper or one parent PID is insufficient. Never stop unrelated Ash instances by executable name.

Ending an agent turn or terminating a JavaScript orchestration cell does not prove the external command stopped. Retain the command's execution/session handle, stop the actual command, wait for its exit, and check for surviving test processes before reporting it stopped.

Runner regression checks: `pnpm run test:smoke:runner` exercises argument selection and cancellation through real subprocesses without running the full smoke suite. After Desktop/Web/backend preparation, `pnpm run test:smoke:runner:product` checks cancellation of real Electron and connected Web instances and their managed backends. Signal-driven subprocess checks require POSIX; they explicitly skip on Windows, where the runner uses `taskkill /T /F` for process-tree cleanup.

## Temporarily loop a test to reproduce a CI failure

For an intermittent failure that appears only in CI, run the affected test repeatedly in the failing CI environment and stop on the first failure. This is a temporary diagnostic change, not a permanent CI step.

1. Identify the failing surface and test title from the job log. Read the current matrix in `.github/workflows/frontend.yml`: Browser runs on Linux, and Electron runs on Windows and macOS; each also runs selected App Server-connected scenarios.
2. On a temporary branch, keep the existing preparation step. Replace the matching smoke test step with a loop over its `no-compile` command. The example below replaces the Electron UI step; use `pnpm run test:smoke:browser:no-compile` for Browser UI.
3. Increase the job's `timeout-minutes` if the selected test needs more time for all iterations. Keep the existing failure artifact upload step.
4. Fix the failure, then remove the loop and restore the normal CI command and timeout before merging.

```yaml
# TEMPORARY: replace the Electron UI test step while investigating a CI-only failure.
- name: Test Electron UI
  if: matrix.surface == 'electron'
  run: |
    for i in $(seq 1 20); do
      echo "::group::Smoke probe run $i/20"
      pnpm run test:smoke:ui:no-compile --grep "<test title>" --max-failures=1 || { echo "::error::Smoke test failed on run $i/20"; exit 1; }
      echo "::endgroup::"
    done
```

The first failure is enough to reproduce the problem. Stopping there preserves its diagnostics and avoids spending CI time on further runs.

## Debugging CI smoke failures

Start with the failing test and error in the GitHub Actions job log. The workflow uploads `.build/desktop/playwright/` on failure as `frontend-<surface>-<runner>`; use the exact name in the failing job. The run ID appears in the Actions run URL. Download the artifact for the failing surface:

```bash
gh run download <run-id> -n frontend-electron-windows-latest -D ./logs
```

The artifact contains `test-results/` and, when generated, `report/`. A failed test that reaches the Workbench fixture attaches `trace.zip` under its test result. Inspect the error and trace to find the failing action, then run that test locally with the same target and filter. If it fails only in CI, use the temporary loop above.

## Distinction from other test types

- Unit tests: `pnpm test:unit`.
- Editor browser integration tests: `pnpm test:editor:browser`.
- Smoke tests: the Playwright scripts above.

## Changing tests

Read [Writing Tests](../../../.github/instructions/writing-tests.instructions.md) for shared fixtures, assertions, readiness, isolation, and cleanup. Reuse `test/automation/test.ts`, `workbench.settingsEditor`, and `workbench.openAgentsWindow(target.kind)` for setup and navigation.

For Sessions restoration, use `workbench.reopenAgentsWindow(application, page)`: web reloads the page; Electron closes and reopens the window with the same profile so asynchronous saves complete. For system-menu assertions, use `captureElectronMenu` from `electronDriver.ts` and trigger the real UI action.

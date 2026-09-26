---
name: smoke-tests
description: Run Ash Browser and Electron smoke tests with pnpm, reproduce intermittent CI failures through temporary repeat loops, and inspect Playwright diagnostics.
---

# Running Smoke Tests

Smoke tests live in `app-ts/test/smoke/` and drive complete Browser or Electron user flows with Playwright. Run these commands from the repository root.

## Scripts

| Target | Prepare and run | Run after preparation |
| --- | --- | --- |
| Electron UI | `pnpm --dir app-ts run test:smoke:ui` | `pnpm --dir app-ts run test:smoke:ui:no-compile` |
| Electron with App Server | `pnpm --dir app-ts run test:smoke:desktop` | `pnpm --dir app-ts run test:smoke:desktop:no-compile` |
| Browser UI | `pnpm --dir app-ts run test:smoke:browser` | `pnpm --dir app-ts run test:smoke:browser:no-compile` |
| Browser with App Server | `pnpm --dir app-ts run test:smoke:browser:full` | `pnpm --dir app-ts run test:smoke:browser:full:no-compile` |

The regular commands run their matching `pretest:smoke:*` preparation first. The `no-compile` commands require that preparation to have completed against the current source. CI runs preparation and execution as separate steps so a temporary repeat loop can rerun tests without rebuilding on every iteration. Extra arguments after the script name go to Playwright; no `--` separator is needed.

## Common options

| Option | Description |
| --- | --- |
| `test/smoke/areas/<area>/<file>.spec.ts` | Select one spec file. |
| `--grep "<pattern>"` | Filter Playwright test titles. |
| `--list` | Show selected tests without running them. |
| `--repeat-each=N` | Repeat every selected test N times in one run. |
| `--max-failures=1` | Stop after the first failed test. |

```bash
# Run the Browser UI suite after preparing its build
pnpm --dir app-ts run test:smoke:browser

# Select a spec and check its tests before running
pnpm --dir app-ts run test:smoke:ui:no-compile test/smoke/areas/windows/home.spec.ts --list

# Run only tests whose titles match a pattern
pnpm --dir app-ts run test:smoke:ui --grep "<test title>"
```

A grep pattern can select more than one test. Check the selected list when the title is not unique. The runner exits nonzero if a selected test fails.

## Temporarily loop a test to reproduce a CI failure

For an intermittent failure that appears only in CI, run the affected test repeatedly in the failing CI environment and stop on the first failure. This is a temporary diagnostic change, not a permanent CI step.

1. Identify the failing surface and test title from the job log. The Browser UI job runs on Linux and the Electron UI job runs on Windows in `.github/workflows/frontend.yml`.
2. On a temporary branch, keep the existing preparation step. Replace the matching smoke test step with a loop over its `no-compile` command. The example below replaces the Electron UI step; use `test:smoke:browser:no-compile` for Browser UI.
3. Increase the job's `timeout-minutes` if the selected test needs more time for all iterations. Keep the existing failure artifact upload step.
4. Fix the failure, then remove the loop and restore the normal CI command and timeout before merging.

```yaml
# TEMPORARY: replace the Electron UI test step while investigating a CI-only failure.
- name: Test Electron UI
  if: matrix.surface == 'electron'
  run: |
    for i in $(seq 1 20); do
      echo "::group::Smoke probe run $i/20"
      pnpm --dir app-ts run test:smoke:ui:no-compile --grep "<test title>" --max-failures=1 || { echo "::error::Smoke test failed on run $i/20"; exit 1; }
      echo "::endgroup::"
    done
```

The first failure is enough to reproduce the problem. Stopping there preserves its diagnostics and avoids spending CI time on further runs.

## Debugging CI smoke failures

Start with the failing test and error in the GitHub Actions job log. The workflow uploads `.build/app-ts/playwright/` on failure as `frontend-browser` or `frontend-electron`. The run ID appears in the Actions run URL. Download the artifact for the failing surface:

```bash
gh run download <run-id> -n frontend-electron -D ./logs
```

Use `frontend-browser` for the Browser job. The artifact contains `test-results/` and, when generated, `report/`. A failed test that reaches the Workbench fixture attaches `trace.zip` under its test result. Inspect the error and trace to find the failing action, then run that test locally with the same target and filter. If it fails only in CI, use the temporary loop above.

## Distinction from other test types

- Unit tests: `pnpm --dir app-ts run test:unit`.
- Editor browser integration tests: `pnpm --dir app-ts run test:editor:browser`.
- Smoke tests: the Playwright scripts above.

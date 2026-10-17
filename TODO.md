# Verification follow-up

Remaining changes were committed locally on `main` on 2026-10-17. Renderer typechecking, the 15 selected unit-test files (543 tests across the initial run and the corrected TaskService rerun), `just verify ash-core`, `just verify ash-external-ext`, and 17 targeted Chromium integration tests passed. Every commit passed `just commit-check origin/main`. Electron smoke scenarios were not run.

- Investigate the activity badge geometry failure in `test/integration/browser/composite.integration.spec.ts`: the compact item measures 16px high with badge top 3px; the assertion expects 24px and 11px. Determine whether the fixture, layout, or expectation owns the mismatch before changing it.
- Reproduce with `pnpm test:browser:integration composite.integration.spec.ts --project=chromium --grep 'activity badges keep compact icons readable'`, then rerun the remaining browser cases stopped by the failure.
- Initial failure log: `/tmp/ash-remaining-browser-tests.log`; passing targeted run: `/tmp/ash-targeted-browser-tests.log`. No publication was requested or performed.

---
name: validate-ui-scenario
description: Use for one-off Ash UI bug reproduction, fix verification, or an explicitly requested recorded test-plan scenario in a real Desktop window. Reuses the scenario runner to capture per-step screenshots, raw video, a Playwright trace, and a report; captioned video requires supported ffmpeg tooling. Routine regression tests, screenshot baseline updates, and backend or documentation-only changes do not require this skill.
---

# Validate UI Scenario

Drive a real Ash window through an observable claim and deliver evidence from the existing runner. Assert behavior independently of the actions; screenshots and video help people review the result, but are not pixel regression baselines.

## When to use it

The upstream [VS Code scenario skill](https://github.com/microsoft/vscode/blob/e7bc1cca4bc2df92b5f21cfdb574e3b34315b042/.github/skills/validate-ui-scenario/SKILL.md) explicitly covers UI bug reproduction, fix verification, and recordings for test-plan items. Its opening text calls this one-off, issue-derived validation and directs deterministic coverage on every build to smoke tests. It does not require a recording for every change or commit.

Upstream [component-fixtures](https://github.com/microsoft/vscode/blob/e7bc1cca4bc2df92b5f21cfdb574e3b34315b042/.github/skills/component-fixtures/SKILL.md) covers isolated component screenshot testing, including themed variants and readiness assertions. Upstream [update-screenshots](https://github.com/microsoft/vscode/blob/e7bc1cca4bc2df92b5f21cfdb574e3b34315b042/.github/skills/update-screenshots/SKILL.md) applies when asked to investigate a CI screenshot diff or update committed component screenshot hashes. Those are separate workflows. Do not turn scenario captures into their baselines or import their external screenshot service into Ash.

The following selection is Ash guidance adapted from those scopes, not an upstream mandatory recording policy. Honor the user's specific evidence request and coordinate shared Desktop/build resources before launching.

| Change or request                                                      | Validation and evidence selection                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit UI reproduction, fix verification, or recorded test-plan item | Use this skill when real-window steps and reviewable evidence are needed.                                                                 |
| Layout, theme, spacing, or another visual change                       | Assert relevant geometry/state and provide key screenshots for visual review. A static change alone does not require a recorded scenario. |
| Complex interaction, timing, or a changed user-visible flow            | Consider a short recorded scenario to show transitions, with assertions at meaningful states.                                             |
| Routine deterministic regression coverage                              | Use existing Playwright/smoke tests; see [smoke-tests](../smoke-tests/SKILL.md). Do not record every commit.                              |
| Existing screenshot baseline or CI diff                                | Follow that test's actual baseline workflow; scenario PNGs are supporting evidence.                                                       |
| Pure backend or documentation change with no UI claim                  | Run the owner's tests/documentation checks. No automatic screenshot/video requirement.                                                    |

## Prepare and choose the target

Read the repository and matching scoped instructions first. Use a disposable fixture workspace containing only synthetic data. Never open personal source files, chats, credentials, or the user's real profile for evidence. Do not copy another checkout's Cargo artifacts, runtime packages, or generated protocols to make a run appear current.

Install the repository's declared pnpm dependencies, then use its existing entrypoints:

```bash
pnpm install --frozen-lockfile
pnpm scenario .build/ash-playwright-mcp/desktop-search.cjs
```

The root `scenario` script runs `prepare:backend`, `build`, `scenario:compile`, then `test/scenario/out/runScenario.js`. Backend preparation may invoke Cargo. Coordinate a build/window slot before this command in a shared environment.

When this checkout's backend and Desktop build are already prepared and current, compile and run without repeating those builds:

```bash
pnpm scenario:compile
node test/scenario/out/runScenario.js .build/ash-playwright-mcp/desktop-search.cjs
```

| Target or option   | Current runner behavior                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No target flag     | Desktop from this checkout, with App Server required. Does not discover installed products.                                                                                                |
| `--dev`            | Accepted by the parser, but currently does not participate in target selection. It does not select a different build.                                                                      |
| `--web --headless` | Current renderer served locally, with App Server explicitly disabled. Covers browser UI only, not full backend Web acceptance. Does not support seeded user settings or Desktop arguments. |
| `--verbose`        | Accepted; do not assume extra diagnostics are implemented.                                                                                                                                 |
| `--build`          | Unsupported; do not use it. Installed-product selection is not implemented by this runner.                                                                                                 |

Desktop uses a temporary user-data directory, an isolated test home/profile, and a 1440×900 recording canvas. The runner stops its owned application/daemon and removes the temporary profile; retain the separate fixture workspace and evidence for review. It must not stop unrelated processes.

Check caption tooling before running. `renderEvidenceChapters.ts` needs `ffmpeg` with the `drawtext` filter, `ffprobe`, and a supported font. It searches `PATH` and known install locations. Overrides are `FFMPEG_PATH`, `FFPROBE_PATH`, and `CHAPTER_FONT`.

| Platform | Tooling installation suggestion |
| -------- | ------------------------------- |
| Windows  | `winget install Gyan.FFmpeg`    |
| macOS    | `brew install ffmpeg-full`      |
| Linux    | `sudo apt install ffmpeg`       |

Without caption tooling, retain the actual raw WebM, screenshots, trace, and report and explicitly report the missing captions. Do not call it an annotated video. Caption rendering is also skipped for multiple window recordings or missing alignment metadata. An existing run can be annotated with `node test/scenario/out/renderEvidenceChapters.js <run-dir>` once supported tooling is available; preserve its actual step timestamps and outcomes.

## Write the scenario

Save a small CommonJS scenario as `.cjs` under `.build/ash-playwright-mcp/`. The repository is an ES module package, so `.js` with `require`/`module.exports` will not work. An ES module with a default export works too. Reuse helpers in `test/automation`; the scenario owns result assertions.

```js
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { expect } = require('@playwright/test');

const workspacePath = mkdtempSync(join(tmpdir(), 'ash-scenario-fixture-'));
writeFileSync(join(workspacePath, 'sample.txt'), 'ash_scenario_token synthetic fixture\n');

module.exports = {
    id: 'desktop-search',
    title: 'Desktop searches an isolated fixture through App Server',
    workspacePath,
    steps: [
        {
            id: 'SEARCH-01',
            title: 'Search synthetic workspace content',
            async run({ workbench }) {
                await workbench.search.open();
                await workbench.search.search('ash_scenario_token');
                await expect(workbench.search.status).toHaveText('1 results');
                await expect(workbench.search.element.locator('.ash-search-preview mark'))
                    .toHaveText('ash_scenario_token');
                return 'The result count and highlighted fixture token match independently of the search action.';
            }
        }
    ]
};
```

| Field           | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `id`, `title`   | Identify the scenario; `id` prefixes the evidence directory.                           |
| `source`        | Optional actual HTTP(S) issue/test-plan link. Do not invent an issue.                  |
| `scenarioPath`  | Optional source path for provenance; the runner does not fill it automatically.        |
| `workspacePath` | Disposable synthetic folder to open.                                                   |
| `userSettings`  | Settings seeded into the isolated Desktop profile before launch.                       |
| `extraArgs`     | Desktop arguments; cannot override `--user-data-dir` or `--folder`.                    |
| `stepPauseMs`   | Hold after each finished step, default `1000`; use `0` for timing-sensitive scenarios. |

Each step receives `app`, `driver`, `code` (an alias for `driver`), `workbench`, `page`, and `skip(reason, options)`. Current Workbench helpers include `settingsEditor`, `quickaccess`, `editors`, `terminal`, `dialogs`, `search`, `menus`, and `git`; do not assume upstream helpers exist in Ash.

- Return a string explaining the independent assertion for the report.
- Throw on a failed assertion. The runner records the failure and stops.
- Use `skip(reason, { needs: 'human' })` for subjective judgment, physical hardware, or required human sign-in.
- Use `skip(reason, { needs: 'infrastructure' })` for an automatable step the harness cannot drive. Name the missing capability in the report.

Skipped steps stop the run with outcome `aborted`, never `passed`. Do not weaken assertions or silently remove blocked steps. Long or virtualized lists require checking the actual rendering contract before declaring an item absent. Use bounded state waits; make race timing explicit. Capture pre-fix behavior when feasible and relevant to the claim.

## Run and inspect evidence

For a local run, set `GITHUB_SHA` to `git rev-parse HEAD` when invoking the runner so its existing manifest commit field is populated. Also record `git diff`/working-tree state: a commit alone does not identify uncommitted changes or prove build freshness.

Missing scenario input exits `2`; failed/aborted runs and load failures exit `1`; a completed passed run exits `0`. Unknown options are rejected. Inspect the manifest as well as the exit code: caption generation is best effort, and a passed UI scenario does not prove video annotation succeeded.

Evidence is written to `.build/ash-playwright-mcp/evidence/<scenario-id>-<timestamp>/`:

| Artifact                                                            | Contents                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.html`                                                       | Step outcomes, validation details, videos and trace/log links.                                                                                                                     |
| `manifest.json`                                                     | Step timestamps, screenshots, outcomes, artifact paths; platform, architecture, Node/Ash versions, `desktop`/`web` target and optional commit. No installed-product quality field. |
| `videos/recording-N.webm`                                           | Actual Playwright recordings saved when the application closes.                                                                                                                    |
| `videos/annotated.mp4`                                              | Only if caption rendering succeeds; H.264 video with a caption band above the original frame.                                                                                      |
| `NN-<step>-started.png`, `NN-<step>-passed.png` (or failed/skipped) | Images at step boundaries; also initial/final captures.                                                                                                                            |
| `logs/trace.zip`                                                    | Playwright trace.                                                                                                                                                                  |
| `logs/workbench.log`                                                | Renderer warnings/errors if observed; do not assume backend/window logs are automatically present.                                                                                 |

Confirm expected step outcomes, finalized non-empty video, and artifact existence. Probe actual video duration/codec/dimensions when tooling permits. Review key PNGs and video for privacy and visual mistakes; runtime/DOM/accessibility/focus/text/geometry assertions remain the behavioral oracle. Do not re-create a video from still images or claim an unperformed UI run passed.

## Deliver the result

Lead with the outcome and independent assertions, then give the actual source, OS, Ash/Node/Electron/browser/backend versions available, commit and build provenance. List failed/skipped steps, human review still needed, harness limitations, and degraded evidence separately from pass/fail.

Provide key PNGs, actual WebM and annotated MP4 if produced, plus report/manifest and exact local paths, byte sizes, and SHA-256 hashes. Use the user's requested delivery channel when authorized; local paths alone do not deliver media to Slack or another remote recipient. Report upload confirmation or the concrete transfer blocker and never invent an attachment URL.

Ash currently has no `test/mcp` entrypoint for this workflow. Its CI does not currently invoke `pnpm scenario` or upload these evidence directories. CI integration and common automation interfaces are separate coordinated work; do not promise upstream engineering-repository labels or build a replacement recording system here.

# Component explorer, screenshots and CSS order scanner

Run from the repository root:

```sh
pnpm component-explorer
pnpm test:component-fixtures
pnpm test:component-fixtures:unit
pnpm test:component-fixtures:ci
pnpm test:component-fixtures:screenshots
pnpm test:component-fixtures:compare --baseline-ref HEAD
node test/componentFixtures/cssOrderScan.mts
node test/componentFixtures/cssOrderBisect.mts --fixture-id-regex '^shared/SelectAndList/ash-dark$'
```

The explorer command prints its local URL. Open it to filter fixtures, preview a theme, inspect the actual CSS source order, reverse that order, and reset it. Stop the server with Ctrl+C. The test command reuses the browser integration runner's process lifecycle and Playwright selection. It checks the explorer and scanner with deliberate faults, then executes the real scan and bisection commands. For direct Node commands on a fresh checkout, run `pnpm prepare:generated` first.

## Files and entry points

The corresponding VS Code responsibilities live at their original relative paths:

```text
test/componentFixtures/
  component-explorer.json
  component-explorer-attach.json
  component-explorer-diff.json
  blocks-ci-screenshots.md
  cssOrderScan.mts
  cssOrderBisect.mts
  cssOrderShared.mts
  playwright/
    playwright.config.ts
    tsconfig.json
    tests/
      cssOrder.spec.ts
      cssOrderShared.test.ts
      screenshotStability.spec.ts
      utils.ts
```

`cssOrderScan.mts` owns multi-fixture scan orchestration. `cssOrderBisect.mts` requires a filter selecting exactly one fixture and owns that command's selection and reporting. Both use the renderer, source mapping, stable capture oracle, adjacent-swap localization, bounded scheduling, and process/server integration in `cssOrderShared.mts`. Playwright specs test these public commands and the actual fixture runtime; Node tests cover the localization algorithm and argument validation.

Ash independently implements the rendering internals with its existing Vite pages and browser runner. The explorer's browser runtime owns stylesheet-node ordering; Node scripts consume its manifest. Screenshot reporting and approval checks live in `build/lib/screenshotDiffReport.ts` and `build/lib/screenshotBlocksCi.ts`. CI lives in `.github/workflows/component-fixtures.yml`, with the existing changed-path selector and required-check fan-in.

## Server configurations

Both commands accept `--config <path>`. The default `component-explorer.json` launches the existing Ash runner's explorer command, resolves its URL from the configured stdout readiness expression, and retains its process tree under the existing `ProcessRun` owner. The command closes its browser and the process owner cleans up its launched server.

`component-explorer-attach.json` connects to an already-running server at port 5123. It launches no server. To use that example unchanged in PowerShell:

```powershell
$env:ASH_COMPONENT_EXPLORER_PORT = '5123'
pnpm component-explorer
```

Run the scan in another terminal with `--config test/componentFixtures/component-explorer-attach.json`. A custom attach configuration needs `server.type: "http"` and `server.url` set to the URL printed by the explorer. A launch configuration additionally needs `server.cmd`, a config-relative `server.cwd`, and `server.wait.stdout`; named capture groups are substituted into `server.url` as `${var:name}`.

To scan a subset:

```sh
node test/componentFixtures/cssOrderScan.mts --fixture-id-regex "SelectAndList" --stylesheet-source-regex "(list|selectbox)\.css$" --time-budget-minutes 2 --concurrency 4 --batch-size 8
```

Arguments use regular expressions without delimiters. The default shared scan budget is three minutes after catalog discovery, with four concurrent pages (allowed range: 1–8). `--batch-size` bounds each scheduled group (default 1000); later groups retain explicit skipped results if the shared budget expires. Each fixture retains one page for all probes. The renderer owns one browser per command. The `:prepared` test script skips generated-asset preparation when those assets already exist.

Commands print the path to `report.md`, alongside `report.json` and component screenshots. These reports include source paths, document positions, content hashes, selected sources, findings, and witness orders. Use `--out <directory>` to select the output location; otherwise a unique directory is created under `.build/desktop/playwright/`.

Browser tests keep their own unique `component-fixtures-*` results directory and HTML report, with the command reports attached. `--list`, `--grep`, and `--repeat-each` on `pnpm test:component-fixtures` use normal Playwright behavior. Fixture filters, source filters, budget, concurrency, and batch size can also be supplied there to select the scan-command test's coverage.

## Local checks before cloud CI

`pnpm test:component-fixtures:ci` prepares generated assets, then runs algorithm/CLI units, screenshot-report and blocking-hash units, fixture browser tests, a fresh screenshot capture, and the committed hash check. Once generated assets are ready, `pnpm test:component-fixtures:ci:prepared` runs the same sequence without preparation. Changed approved screenshots and rendering errors fail it. The proposed approval list is saved as `.build/component-fixtures/blocks-ci-updated.md`; it is not approved automatically.

The browser suite includes byte-for-byte screenshot repeatability across fresh browsers and an actual Git-worktree comparison with cleanup. Unit tests deliberately change an approved hash and require exit status 1. Format, build/browser type checks, and CI selector tests are separate cheap checks. Full platform builds and hosted Actions artifact integration remain cloud validation.

## Screenshot capture and baseline comparison

```sh
pnpm test:component-fixtures:screenshots
pnpm test:component-fixtures:compare --baseline-ref HEAD --out .build/component-fixtures/comparison
```

Capture writes `.build/component-fixtures/screenshots/current/manifest.json` and content-addressed PNGs. Screenshots include the union of real roots, preserving popup position and overlap. Computed state must remain stable and repeated PNGs must match byte for byte. Manifests record platform, Chromium version, labels, hashes, and errors. Rendering failures and exhausted budgets remain explicit and make screenshot commands fail.

`component-explorer-diff.json` selects sessions through `compare.current` and `compare.baseline`; the baseline owns `source.worktree.ref`. `--baseline-ref` overrides it. The runner resolves a commit and creates a detached worktree under `.build/`. Both sides use the current fixture harness and installed dependencies; the baseline Vite resolver loads production modules and CSS from that worktree. This tests older product code even when it predates fixture infrastructure. It compares current scenarios against older product behavior, rather than historical fixture definitions or dependency versions.

Comparison requires isolated launched servers; attach-only configs cannot switch production sources. The current session clears the baseline override. Cleanup checks the exact owned worktree path and removes it without `--force`, preserving unexpected edits. Existing user worktrees and both source checkouts are preserved.

Output includes baseline/current manifests, side-by-side images in `report.md`, and changed/added/removed/errored classifications in `report.json`. Environment mismatches and missing or corrupt images fail validation. Visual changes produce review evidence; the committed approval list separately determines CI blocking.

To approve reviewed screenshots on the canonical Windows/Chromium environment:

```sh
pnpm test:component-fixtures:screenshots --update-screenshots
```

This regenerates `test/componentFixtures/blocks-ci-screenshots.md` from a complete successful capture. Filtered or comparison runs cannot update it. Mark important scenarios with `labels: ['blocks-ci']` in `defineComponentFixture`; all three initial groups are marked. Adding or removing marked fixtures also changes approval state. PNGs stay in build outputs and Actions artifacts; the committed Markdown links to the canonical local capture directory.

CI uses the same prepared runner commands on Windows with lockfile-pinned Chromium. The hash checker compares captures to the committed list, never rewrites it, and fails on changes. It uploads proposed hashes, before/after images, browser diagnostics and reports even on failure, and writes the comparison to the job summary. External screenshot hosting, write tokens, and PR-comment posting are not required. A hosted OS/font image upgrade may change pixels; review its artifact before explicitly approving that change.

## Adding fixtures

The explorer discovers `src/**/*.fixture.ts`. Keep shared workbench fixtures in `src/ash/workbench/test/browser/componentFixtures/`; import helpers from its `fixtureUtils.ts`. Each file default-exports `defineThemedFixtureGroup({ path: 'feature/' }, scenarios)`. It expands each scenario into Ash Light, Dark, High Contrast Dark, and High Contrast Light. Fixture IDs must be unique.

```ts
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

export default defineThemedFixtureGroup({ path: 'example/' }, {
	Default: defineComponentFixture({
		render: ({ container, disposableStore }) => {
			disposableStore.add(new Button(container, { label: 'Example', ...defaultButtonStyles }));
			return [container];
		},
	}),
});
```

Render the actual production component and register its resources in `disposableStore`. Import its real CSS dependencies. Reproduce required ancestor classes rather than changing selectors just for the fixture. Return connected root elements, including any popup rendered outside the container; those roots and all descendants are sampled. Rendering may return a promise. Finish asynchronous setup before returning. The explorer applies theme tokens through the existing browser theme helper, and the scanner waits for fonts and two animation frames before capture.

Fixtures have separate iframe documents. They share the eagerly discovered fixture modules' CSS, allowing interactions between shared base styles and component styles to be exercised. They do not use shadow DOM, a synthetic copy of the component, or a separate service registration framework. Add domain services only when a real fixture needs them, following the existing test service owners.

## What the scanner verifies

The scanner runs against the Vite development server so each source CSS document has real `data-vite-dev-id` metadata. It moves those existing stylesheet nodes between fixed comment slots; it does not append a second, reparsed copy of a stylesheet. Dynamic theme styles keep their slots. Changes to the source CSS during a scan invalidate the run.

Each fixture is captured in the original order twice, with selected CSS documents reversed, and after restoring the original order. The oracle compares computed styles, generated pseudo-elements, bounds, scroll dimensions, focus/ARIA state, and cropped component screenshots. It ignores only the `background-position` shorthand (its longhands are compared) and pixel deltas of at most 1/255 from repainting; raw pixel counts remain in finding diagnostics.

On a difference, binary search follows a path of adjacent stylesheet swaps from the original order to the requested reversal. It keeps endpoints with different rendering verdicts; it does not assume intermediate verdicts are monotonic. The final pair is rendered again for confirmation. Its before/after orders, property differences, and screenshots are retained. A source filter limits the initial reversal; localization may identify an unselected stylesheet crossed by a selected one. An unmapped dynamic stylesheet between the final two sources prevents confirmed source-pair attribution.

Statuses are explicit:

- `clean`: this fixture is stable under the requested reversal and restoration.
- `localized`: a rendering difference has a confirmed adjacent source-pair witness.
- `unlocalized`: a difference was detected, but localization, confirmation, or restoration could not finish reliably.
- `error`: rendering or baseline stability failed before a reliable difference was established.
- `not-scanned`: budget expired or no CSS documents matched the filter.

Rendering errors make either command exit with status 1 after diagnostics are saved. Findings and incomplete coverage remain in the reports and add annotations in the browser tests; this is an exploratory scanner, so findings alone do not fail it. Keep targeted behavioral regressions, such as `cssOrder.integration.spec.ts`, as normal test gates. Bisection without an explicit fixture filter, or with a filter matching several fixtures, fails with an actionable error.

Current coverage is three real component groups × four themes: Buttons/Menu, SelectBox/List (including its popup), and ObjectTree/InputBox/find input. A clean reversal is evidence for these rendered states, not proof that every permutation, interaction state, production bundle, or component in the repository is independent of CSS order. One confirmed pair does not enumerate every conflict in a fixture.

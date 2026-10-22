# Stanza distribution tests

This suite opens the production Stanza build in Chromium and Firefox. It covers
asset loading, keyboard editing, undo/redo, multiple cursors, public editor
lifecycle, and accessibility. The browser loads only the standalone product page;
tests do not inject editor implementations, Workbench contributions, or test services.

From the repository root:

```sh
pnpm exec playwright install chromium firefox
pnpm test:stanza
pnpm test:stanza --project=chromium --grep 'keyboard'
pnpm test:stanza --list
```

The runner collects the selection before building or starting a server. Empty
selections and invalid options fail. Each run builds with the production Vite
configuration into its own temporary directory and serves those assets on an
OS-assigned loopback port. Cancellation and child-process cleanup use
`build/processes.ts`.

After `pnpm build:stanza`, use `pnpm test:stanza:no-compile` to test a snapshot of
that output without rebuilding it. CI uses this entry after its explicit build.
The caller is responsible for keeping that build current.

Results, failure screenshots, traces, runtime errors, and the HTML report are
saved under `.build/desktop/playwright/stanza-<id>/`. Temporary served assets are
removed when the runner exits.

Detailed editor behavior belongs in `test/integration/browser/`; complete
Workbench flows belong in `test/smoke/`.

On Windows, Firefox uses the physical path of its installed executable when the
cache is redirected by an MSIX host. This lets Windows resolve the adjacent
`mozglue` assembly while retaining the selected Playwright browser cache and
version. No browser-cache environment override is needed. Test collection also
works before browsers are installed.

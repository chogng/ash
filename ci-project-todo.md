# Frontend CI Playwright project repair

Integration checkout: `77fcedc89454486f85340ce74bc69a24db44c56d`.

1. [x] Confirm history: commit `7233983` removed `electron-academic-ui` and moved Academic editing into the unified Workbench projects.
2. [x] Keep the Academic CI step, select `academic-workbench.spec.ts` with `electron-ui`, and retain connected Academic document editing through `electron-editor-app-server`.
3. [x] Add two build-tool contract regressions. Both fail against the original workflow and pass against the repair. The build TypeScript compilation and `git diff --check` pass.
4. [x] Diagnose project selection with the pinned Playwright CLI: the removed project fails; its replacement lists 4 tests in 1 file; connected editing lists 54 tests in 2 files, including Academic document saving.

The `--list` diagnostic reused a selected package through the existing protocol preparation API after all 577 source files and 1359 artifact digests matched this checkout. It does not establish a normal product build in this checkout. Electron runtime scenarios, Windows/macOS acceptance, and the complete build-tool suite were not run. No lockfile changes or Rust/full product builds were performed.

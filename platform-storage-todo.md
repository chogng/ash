# Platform storage lifecycle alignment

The current slice makes Desktop startup loading, migration, requests, flush, and close belong to the existing storage owner's queue. It does not claim full storage API or product parity.

## Baseline and boundary

- Ash: latest `origin/main` fetched on 2026-10-08, `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`.
- VS Code: fixed audit reference `88f4baf8714b14cd299f5cbba2e9920cc59d24df`.
- Independent clone: `ash-platform-storage-cloud`, branch `align/platform-storage`.
- Initial tracked and untracked changes: none. Dependency files are independent copies, never shared writable trees. Generated contracts and build outputs are produced only in this clone. Rust business code is unchanged; the normal TypeScript preparation still requires the existing protocol export.
- Allowed implementation and test paths:
  - `src/ash/platform/storage/electron-main/storageMainService.ts`
  - `src/ash/platform/storage/test/electron-main/storageMainService.test.ts`
  - This root work record
- These implementation/test paths both have exact VS Code counterparts. No production file is added, removed, renamed, or replaced. Preferences, configuration UI, editor backup/shutdown integration, AgentHost, SCM/Terminal, notifications, search UI, and base async are read-only or untouched.

## Owner and production call chain

Desktop startup → `code/electron-main/app.ts` constructs `StorageMainService` → `initialize()` reads `workbench-state.json` and, for v1, archives the original then atomically writes v2 → the same service registers the `storage` IPC channel → renderer `NativeWorkbenchStorageService` uses `getItems` / single-key `updateItems` → the same owner serializes atomic writes and emits revisioned scope snapshots → `closePersistentServices()` awaits `StorageMainService.close()`.

State and disk owner remain `StorageMainService`. `StorageDatabaseChannel` remains a validated transport adapter. Renderer caches remain in the existing Workbench adapter. DOM, input coordinates, layout, and visual ownership do not apply to this lifecycle-only change.

Current defect: `initialize()` performs asynchronous disk operations outside `queue`, while `flush()` and `close()` wait only for `queue`. Closing during startup can resolve before migration writes finish. Requests accepted while startup is pending can create an empty scope before its durable data is loaded.

The fixed upstream lifecycle tests include `storage closed before init works` and `storage closed before init awaits works`. Upstream external behavior establishes the closing barrier; Ash keeps its own JSON format and existing single writer rather than importing upstream SQLite classes or private implementation.

## Independent implementation plan

- Admit the initialization body once into the existing queue, sharing its inner result for parallel and repeated calls. Keep the original async public entry: closing and disposal errors must be returned as Promise rejections that direct `.catch(...)` callers can handle.
- Keep initialization's returned rejection visible to the startup caller; do not turn failed startup into success. The failed inner result is permanently cached for that owner. Repairing the storage file does not retry initialization on the same instance; a fresh owner is required.
- Keep queue rejection recovery for unrelated requests. Avoid calling queued `getItems()` from inside queued initialization.
- Retain synchronous close admission, idempotent close, scope protection, event timing, migration precedence, archive format, and atomic writes.
- Closing before any initialization rejects later startup, so a closed owner cannot begin disk work.

## Regression evidence

- [x] Red: close during real v1 migration must wait for initialization and observe v2 + retained archive at the closing boundary, with no accepted late mutation.
- [x] Red: IPC get/update queued during loading must retain preexisting keys and survive reopen.
- [x] Red: concurrent/repeated initialization must not reload or reject a previously loaded identity.
- [x] Red: close before startup must reject later initialization without creating storage.
- [x] Direct `.catch(...)` handles close-before-initialization and disposed-initialization failures asynchronously.
- [x] Initialization error remains visible and source bytes stay unchanged; after file repair the same owner still rejects, while a fresh instance loads the repaired data.
- [x] Rejected mutation does not poison flush or another scope's subsequent durable write.
- [x] Existing Desktop owner and renderer cache tests remain green.
- [x] Owning host build, formatting, and diff checks pass, or verified unrelated blockers are recorded below.

## Cloud validation setup and status

- Node 24.21.0 and pnpm 12.8.0 are available in this clone's independent dependency/toolchain tree.
- Actual root + build package directories and versions were checked against the formal dependency importer in the multi-document frozen lockfile: 37 packages matched, with no missing package or wrong version. `native-keymap` is the complete official 3.3.9 source/declaration package, never a stub; no native binary was copied or substituted.
- The dependency tree's source-path metadata triggers pnpm's default auto-install when used from a clone. After that installation was canceled, it was not retried. Final package scripts use the supported `pnpm_config_verify_deps_before_run=warn`: metadata is still checked and its warning is preserved; no compiler, generator, test, or build guard is disabled.
- An earlier attempt copied a source/hash-verified protocol export from another tree. This violates the required generated-output isolation and does not count as normal generation. The copy was removed before final validation: own `.build/protocol-package` (1360 files), `.build/protocol` (1359 files), protocol input/source manifests, and `.build/desktop/test/.build/protocol` (1357 files). No source tree was touched. All final contracts were generated by this tree's unchanged normal `build/protocol/generate.ts` entry, with `CARGO_BUILD_JOBS=2`, independent Cargo home and target outputs.
- The first complete `test:unit` attempt was blocked before Mocha by two missing-`native-keymap` TS2307 diagnostics. The package is now present as an independent complete dependency copy.

### Actual red/green diagnostic entry

The repository's TypeScript test options are inherited unchanged through `.build/platform-storage-test/tsconfig.json`; only `include` narrows to the two affected storage files. Compilation outputs remain under `.build/desktop/test`.

Commands:

- `node_modules/.bin/node node_modules/typescript/bin/tsc -p .build/platform-storage-test/tsconfig.json`
- `node_modules/.bin/node test/unit/run.ts --run src/ash/platform/storage/test/electron-main/storageMainService.test.ts --run src/ash/workbench/services/storage/test/electron-browser/storageService.test.ts`

Red before production changes: 15 tests executed / 2 files; 4 failures. Close-before-startup-work-completed observed `initialized=false`; startup versus IPC requests and duplicate startup both hit `Duplicate Desktop storage identity`; initialization after close failed to reject. The other 11 tests passed.

Initial green after the minimal queue fix: 17 tests / 2 files, 0 failures. Independent review then identified an unnecessary exception-timing change from replacing the original async public method with a synchronous method. Direct `.catch(...)` regression cases reproduced two synchronous throws (closed/disposed owner) before the correction. Restoring the original async entry retained the cached inner initialization body and turned both cases green: 18 tests / 2 files, 0 failures. Close and pending-init flush assert real v1-to-v2 disk state and retained archives at the barrier, without relying on outer Promise identity or callback microtask ordering. The duplicate-startup test reenters initialization from a production storage change event without deadlock; actual EISDIR recovery and failed-owner/new-owner behavior remain covered. Original and review-correction red/green output is preserved under `.build/platform-storage-evidence`.

### Final standard entry

Environment additions: task-local Node/pnpm/Cargo toolchain paths; `CARGO_HOME=.build/storage-cargo-home`, `CARGO_TARGET_DIR=.build/cargo-platform-storage`, `CARGO_BUILD_JOBS=2`, the existing installed Rustup toolchain, and `pnpm_config_verify_deps_before_run=warn`. The host retry also uses the task-owned `HOME=.build/host-home`.

- Own protocol: `node_modules/.bin/node build/protocol/generate.ts` completed with exit 0. No copied generated artifacts remain. Normal subsequent `pnpm run protocol:generate` in the standard test preparation also passed. Export metadata: major 7, schema hash `sha256:d0855515d162555ff96db2eff76aeb9a8c9c137cde5a62c10b15c9d1579b1e86`.
- Standard unit entry: `pnpm test:unit --run src/ash/platform/storage/test/electron-main/storageMainService.test.ts --run src/ash/workbench/services/storage/test/electron-browser/storageService.test.ts --run src/ash/workbench/services/storage/test/browser/storageService.test.ts --run src/ash/workbench/services/storage/test/browser/observableMemento.test.ts` completed with exit 0. Its normal prepare hooks, complete `tsconfig.test.json` compilation, runner self-tests (5/5), and selected suites (28 tests / 4 files) all passed. This is a selected test run, not the whole repository suite.
- Standard host entry: `pnpm build:host` failed with exit 255 in native rebuild. The first default-HOME attempt could not create `/home/agent/.electron-gyp`; the task-local HOME retry reached the actual official `native-keymap` build and failed because this image has neither pkg-config `x11` nor `xkbfile`. No native stub or fake binary was used; the package entry is not reported as passing.
- Actual host production build body: `node_modules/.bin/node build/desktop/build.ts host` completed with exit 0, including its own normal protocol/localization preparation, Main + Preload builds, and preload verification. This isolates the affected TypeScript production build and does not replace the failed native-rebuild prerequisite above.
- `pnpm format:ts src/ash/platform/storage/electron-main/storageMainService.ts src/ash/platform/storage/test/electron-main/storageMainService.test.ts`: passed; 0 unformatted.
- `pnpm exec prettier --check platform-storage-todo.md`: passed.
- `git diff --check`: passed.
- Standard pnpm commands retain the verified environment warning: `Your node_modules are out of sync with your lockfile. The workspace structure has changed since last install`. Actual package directories/versions were independently checked against the frozen lock as described above. Do not claim a warning-free environment.
- Browser/Electron Playwright: not run. The blocked native build prevents a complete Desktop product acceptance result. This slice's evidence is E3 real lifecycle/filesystem + Node/jsdom behavior, not E4 Desktop/Web UI acceptance.

Diagnostic red/green output, final standard-test output, protocol output, host prerequisite failure, actual host build-body output, formatting output, and the reviewable patch are preserved in `.build/platform-storage-evidence`.

## Final boundary and remaining work

The cloud patch changes only the two approved TypeScript paths and this root record. The main hunk adds one shared initialization result and submits the existing loading/migration body to the existing queue; it is an Ash-independent lifecycle implementation. Test hunks cover the actual owner and production IPC adapter. No new service, export, transport DTO, mutation path, permission, persistent credential, caller migration, or filesystem format is introduced.

The full storage directory comparison still has upstream-only `common/storageService.ts`, `electron-main/storageMain.ts`, and common storage tests, while local `node/revisionedJsonFile.ts` has no same-path upstream counterpart. Those files were not pulled into this closed lifecycle slice. Full StorageService API parity, browser cross-window contention, profile switching, target events, and the rest of P01 remain separately unverified.

The review correction passed its final related cloud validation: the original async public entry is preserved, and direct Promise catch consumers are covered. At the cloud handoff, system-dependency and real Electron/Playwright acceptance were pending; the Mac results below close those validation gaps for this slice, without claiming full storage API parity. No commit or push was made.

## macOS continuation

The original cloud patch was reconstructed from the supplied text and verified before application: 27304 bytes, SHA-256 `bb48ef65c9da107834c6d4491e5d9409eed4d26aa8d1164a6cc985f30bb1b6b6`. Its two resulting source blobs remain `206ab8ba29a2238784200d6cee2ce0d56e745aaa` and `508f89d9f265b5c095a2b002e48a9b53784c84b7`.

The independent task checkout is `/Volumes/1t/ash-platform-storage-20261008`, branch `codex/platform-storage-mac-20261008`. It was created at `c6d6db1ef0171832536c6ff16e87a939c8c8a813`, then updated to fetched `origin/main` `e05e17e93c26f0281357ff9aca53bea8aaf98a67`. Before that update, the complete tracked changes and original work record were saved under `/tmp/ash-platform-storage-evidence-20261008`; changes were restored and checked after updating. This task has not modified the primary checkout.

Node 24.21.0, pnpm 12.8.0, Rust 1.98.0, Python 3.14.2 and Go 1.27.1 were verified on macOS arm64. `pnpm install --frozen-lockfile --offline` completed with 330 packages cloned from the verified local pnpm store; lockfiles are unchanged. pnpm reported that its default user store is on a different volume and selected `/Volumes/1t/.pnpm-store/v11`. No dependency guard was disabled.

Protocol generation used this tree's unchanged normal entrypoint with `CARGO_HOME=.build/storage-cargo-home`, `CARGO_TARGET_DIR=.build/cargo` and `CARGO_BUILD_JOBS=1`. No Cargo outputs, runtime or generated contracts were copied from another checkout. The normal generation completed with exit 0; metadata remains major 7 and schema hash `sha256:d0855515d162555ff96db2eff76aeb9a8c9c137cde5a62c10b15c9d1579b1e86`.

Completed checks against the updated task baseline:

- Standard selected `pnpm test:unit` with the four storage files listed in the cloud section: normal preparation, complete test compilation, runner self-tests (5/5), and 28 tests / 4 files passed.
- `pnpm build:host`: passed, including the real macOS keymap rebuild, Main and Preload builds, and preload verification. The cloud Linux prerequisite blocker does not apply to this Mac result.
- `pnpm typecheck:renderer`: passed.
- `pnpm exec tsc -p test/automation/tsconfig.json`: passed, including a repeat after the migration smoke setup correction.
- `pnpm build:web` and `pnpm build:renderer`: passed.
- Normal `pnpm prepare:backend`: passed, including the complete Rust `dev-small` build, own Go dependencies, own tgrep release build, package validation/publication and desktop selection.
- Real backend stdio `initialize`: passed against that published Mac package with a temporary profile, this tree's standard-compiled generated decoder, major 7 and the matching schema hash. EOF produced normal exit 0 with empty stderr; the temporary profile was removed.
- `pnpm test:smoke:browser:no-compile test/smoke/areas/windows/font-cache.spec.ts --grep 'Workbench saves|Workbench discards|Browser migrates'`: 4 tests passed using the production Web build, a task-selected free loopback port and isolated headless browser contexts. The desktop-only scenario was excluded rather than counted as passing.
- Repository TypeScript formatting for the two storage files and two smoke files: passed; 4 files checked, 0 unformatted.
- Real-App-Server Electron acceptance: both selected storage scenarios passed across the initial two-test run and the targeted migration rerun described below.
- `git diff --check`: passed.

The browser run reports inherited `NO_COLOR`/`FORCE_COLOR` warnings; these affect log coloring. Normal generated preparation reports 0 missing zh-CN locale entries and 28 entries unchanged from source. Neither message is introduced by storage code.

Two approved existing smoke files now extend the acceptance boundary: `test/smoke/areas/windows/font-cache.spec.ts` quits the migrated profile at the first Workbench-ready boundary, checks durable v2 and the unchanged v1 archive, and relaunches to verify fonts and Sessions layout; `test/smoke/areas/windows/multi-workbench.spec.ts` checks real IPC application writes shared across two windows, workspace-key isolation, sidebar isolation and workspace values after reopening the second window. These additions compile, are formatted, and have passed real-App-Server Electron acceptance. The migration setup now closes its fully loaded Agents window through the real close handshake before preparing the v1 file, retaining its sidebar value while keeping the migration launch to one Workbench. No production service or test-only product API was added.

Normal backend preparation used the same own Cargo paths and jobs=1, plus task-owned GOPATH, GOCACHE and GOMODCACHE and GOMAXPROCS=1. Two direct execution attempts were interrupted by execution-channel loss, first after dependency downloads and then during compilation; neither has a completed exit result, and no surviving task process was found before each resume. The same normal command subsequently ran under a task-owned detached controller that preserves its process, command log and completed exit independently of the execution channel. Cargo reported partial-download and HTTP/2 retry warnings.

The first durable normal backend attempt exited 1 because the existing V8 build script runs locked offline metadata and the independent Cargo cache lacked the cross-platform `android_system_properties 0.1.5` source. That failure and the suppressed initialize are preserved as `v8-metadata-failure-*`. No guard was changed: task-owned `cargo fetch --locked` completed with exit 0, and the same `cargo metadata --locked --offline --format-version=1` completed with exit 0 over 1222 packages, locating V8 150.4.0 in this task's Cargo home. The restarted normal prepare completed its full Rust `dev-small` build in 5m 55s and own tgrep release build in 2m 02s, prepared package `0e8f2ca7f631277d53bce2dbaa54922e0a51d8c09a59a02ee59ee4df571d39f6`, published desktop selection `52c90871a876563b35f6bdfe61440d31c4cfdef04b2ac9d4c53745d18165e98b`, and exited 0.

The first initialize diagnostic failed during helper imports, before spawning the server: Node's strip-only mode rejects the generated decoder's TypeScript parameter property. Its log is retained as `diagnostic-import-failure-*`. The diagnostic now imports this tree's standard test-compiled decoder JS without editing generated source. Actual initialization against the published package succeeded, with protocol major 7 and the same schema hash, normal EOF exit 0 and empty stderr. `backend-initialize.json` records the exact package, executable and process; the temporary profile was removed.

The initial connected Electron command ran two tests: the application-sharing/workspace-isolation scenario passed, while immediate migration exit reported two `IPC connection closed` errors from a concurrently restored Sessions renderer. Its v2 durable document, retained application value and exact v1 archive assertions had already passed. The failed run and profile/log artifacts are retained as `electron-autorestored-sessions-failure-*`.

A same-baseline control used the original, unmodified storage owner from `e05e17e93`, a normal `pnpm build:host`, and the same migration test. It reproduced the same Sessions cancellation error. A `finally` restored the exact patched owner blob and another normal `pnpm build:host` passed; `baseline-control-comparison.json` records all exits and the restored source hash. No Sessions, IPC, or product shutdown code was changed.

The storage smoke setup closes Agents through its actual BrowserWindow close handshake after saving its sidebar layout. The migration launch now asserts one Workbench at the first ready boundary and quits immediately; no startup delay or diagnostic filtering was added. The setup, migration exit and reopen retain their empty-error assertions. Normal automation typecheck and TypeScript formatting passed after this test change. Only the failed migration scenario was rerun with the real App Server and passed (1 test, 13.0s command duration). The unchanged two-window scenario had already passed (2.7s) on the exact same patched owner; it verifies shared application writes in both directions, workspace and sidebar isolation, and durable values after reopening.

The parent temporarily reserved the desktop for BrowserView OS-focus cases, then explicitly released it. These storage tests used independent profiles, HOME, workspaces, backend and output through existing fixtures, one Playwright worker and one Electron instance at a time. They used no system menu or global clipboard operation. All owned test commands have finished; this task has no running UI. The prepared connected command remains:

```sh
pnpm run test:smoke:desktop:no-compile test/smoke/areas/windows/font-cache.spec.ts test/smoke/areas/windows/multi-workbench.spec.ts --grep 'Desktop migrates|a second instance opens'
```

The preexisting Sessions auto-restore startup-cancellation issue is outside this closed storage-owner change. Its real same-baseline reproducer is retained for the parent; the accepted storage scenario covers a profile whose setup Agents window has been closed, with its saved sidebar restored explicitly after reopening. This result does not claim that quitting while another renderer is still starting is error-free.

This task's own dependency, Cargo, protocol, runtime and build caches remain in the independent checkout for continuation in the same conversation. The initial Mac acceptance ended without a commit or push. The next parent continuation requested the local commit and rebase recorded below; no push has been made.

Command logs, completed exit statuses, source backups and the verified original patch are retained in `/tmp/ash-platform-storage-evidence-20261008`, with a continuation copy under `.build/platform-storage-evidence`. Interrupted execution sessions are not reported as successful checks.

## Local integration preparation

The complete pre-rebase change set, all five source files, unfiltered Sessions errors, original-owner control and the matching minified stack assets are preserved under `.build/platform-storage-evidence/pre-rebase-20261008`. The change was committed locally as `fix(storage): serialize startup with flush and close`, then fetched and rebased without conflicts onto `origin/main` `a139432ecd29372bda3d218ff4be56a91e9c520a`. The five task files remained byte-for-byte unchanged during rebase. The branch contains only those five paths relative to that pinned upstream base; existing storage adapters, configuration, preferences/user-settings, application host and Sessions production code match that base. The primary checkout was not edited. Push is deferred to the parent's serial integration queue after Browser and SCM.

The upstream interval changes base lifecycle/IME, Browser, Tasks, textfile and media-preview. Cargo, dependency lockfiles, build/protocol scripts and Rust sources are unchanged, so the normal backend preparation correctly reused this task's own validated package rather than copying another tree's output.

Fresh checks after rebase all completed successfully:

- Standard unit entry: 51 tests / 6 files, 0 failed, covering the four storage files (28 tests) and the affected base disposable-tracker/IME suites; runner self-tests remained 5/5 and complete test compilation passed.
- Normal Mac `pnpm build:host`, including the real keymap rebuild; `pnpm build:renderer`; `pnpm build:web`; renderer typecheck; automation typecheck: all passed.
- Normal `pnpm prepare:backend` and real stdio initialize: passed, using the same own package and matching generated major-7 schema; normal EOF exit and empty stderr.
- Connected Electron command with both storage scenarios in the same run: 2 passed (17.8s). The migration profile closes its setup Agents window and still quits at the first Workbench-ready boundary, then restores fonts/layout; shared application values and workspace/sidebar isolation survive the second-window reopen.
- Production headless Browser storage command: 4 passed (8.3s), using a task-selected free loopback port. Electron profiles/logs were preserved before this separate run reused the Playwright output directory.

The independent Sessions cancellation observation remains outside this storage change. The original diagnostic array contains two identical entries, both preserved in `sessions-error-array-unfiltered.txt`; `sessions-first-diagnostic-stack.txt` contains one complete entry and `sessions-startup-cancellation.json` records the verified symbols, phase and baseline commands. `IPCClient.closeError` is constructed at `base/parts/ipc/common/ipc.ts:109` and reused when rejecting pending calls, so this creation stack does not identify which RPC method was pending. The observed Sessions window logged Ready at 1791455873465, windowClose shutdown at 1791455873688 and Agents restored at 1791455873955. The original owner on `e05e17e93` reproduced the same error after normal host build, while v2/value/archive assertions had already passed. No Sessions owner or IPC error handling was changed, and no error was filtered.

Post-rebase logs, exact commit/base identities and the regenerated reviewable patch are retained in `.build/platform-storage-evidence`. All owned acceptance commands have ended; no UI is running. The storage closure is validated, while automatic-window restore followed by immediate quit still has the separately reproduced baseline cancellation issue. No push has been made.

## Final SCM integration refresh

After that first rebase, the shared upstream advanced through four SCM commits to `346993c53151be1777d5a9aa8e7c1a90db893f3e`. A fresh fetch and second rebase completed without conflicts. All four task TypeScript files still match the preserved pre-rebase SHA256 values, including the exact received owner/test blobs. No upstream storage, user-settings, configuration, application host or Sessions production change was overwritten. The local branch remains exactly five files ahead of that pinned upstream base.

This new interval updates the shared Git protocol and App Server. This task therefore regenerated its own protocol and ran the normal backend preparation again with its independent Cargo output and jobs=1. The actual `dev-small` rebuild completed in 3m 32s and published own package `6dc21757f4958a28e68921737a6033b28def52793197482f51ff804b1bbb722d`, selection `32c5cd9f8ccbf8f1374134b77980339ce5a265c4119d3e1bb160f2e89e6c03e8`. Real initialize decoded successfully against this tree's generated contract: major 7, schema hash `sha256:2e9c381ddea342d0d4fc025cfdf9b9914fb8f22d327c663ece5479ef4a7cc27f`, normal EOF exit 0 and empty stderr. Older package/protocol evidence above remains historical evidence for its original base.

Fresh latest-base validation passed: standard unit preparation and complete test compilation, runner 5/5, 51 selected tests / 6 files (28 storage tests), normal Mac host/keymap and renderer/Web builds, renderer and automation types, normal own backend preparation and initialize, two connected Electron cases in one run (18.0s), and four production headless Browser cases (8.2s). Latest Electron profiles, durable v2 documents, v1 archives and window logs were retained before the separate Browser run. The only smoke warning remains inherited NO_COLOR/FORCE_COLOR log coloring; localization still reports 0 missing zh-CN entries and 28 unchanged source entries.

The full baseline Sessions diagnostic array and original-owner control remain unfiltered. The automatic-window-restore variant was reproduced on `e05e17e93`, not rerun on this final SCM base. This validated storage closure does not resolve or claim acceptance for that independent cancellation issue. Only this work record was updated after code validation; all four code files stayed unchanged. The final local conventional commit and clean-base/reverse checked patch are recorded in `.build/platform-storage-evidence/mac-integration.json`. No push was made; parent integration remains serial after Browser and SCM.

## Main slot publication

The parent explicitly assigned Storage the main publication slot after the Search CI fix was confirmed at `86ac6c9cf518f8e16c1d22d99675062a16b752c5`, and authorized normal non-force publication without another confirmation. This branch was fetched and rebased onto that exact base without conflicts. The four code files still match the preserved pre-rebase bytes; only the work record changed after validation. All existing Search, preferences/user-settings, Sessions preferences and other owner changes are retained from upstream. The branch still changes only the original five approved paths.

Fresh affected checks on this publication base passed: standard preparation, complete test compilation, runner 5/5, 28 storage tests / 4 files, normal Mac host/keymap and renderer/Web builds, renderer and automation types, normal own backend preparation, real initialize with matching major 7/schema and empty stderr, two connected Electron tests in one run (16.6s), and four production headless Browser tests. Rust/protocol inputs did not change in this interval, so the normal backend entry reused this task's own package `6dc21757f4958a28e68921737a6033b28def52793197482f51ff804b1bbb722d`. Passing Electron profile/log artifacts were preserved before Browser acceptance.

The publication uses a normal non-force push, followed by a direct remote-main identity check; its actual result is recorded in `.build/platform-storage-evidence/mac-publication.json`. After confirmed publication, the main slot is released to Trace. The independent Sessions automatic-restore immediate-quit issue and its unfiltered original-owner control remain unchanged; that variant was not rerun on this publication base and no Sessions production fix is included.

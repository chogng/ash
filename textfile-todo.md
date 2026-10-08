# Text-file App Server document identity

`textDocument/list` must include dirty editor text when the App Server root and editor file URI differ only in Windows drive-letter spelling. The App Server owns the root's filesystem identity; the renderer returns relative paths and never rewrites persisted document identities.

## Scope and ownership

- Baseline: `e05e17e93c26f0281357ff9aca53bea8aaf98a67`, independent cloud checkout `ash-remote-document-cloud`.
- Production owner: `src/ash/workbench/services/textfile/browser/appServerTextDocumentHost.ts`, its `list` handler only. Snapshot leases, read/apply behavior, model identity and saving remain with their existing owners.
- Request flow: Rust `ConnectionDocuments.open_documents` → `textDocument/list` → `AppServerProtocolClient` → `AppServerTextDocumentHost` → dirty text entries in `IWorkingCopyService` → relative paths → Rust `root.join(relative_path)`.
- Tests: existing `src/ash/workbench/services/textfile/test/browser/appServerTextDocumentHost.test.ts`, through its real protocol client, service container, working-copy registry and text models. The existing `C:/workspace` versus `c:/workspace/open.txt` regression stays unchanged.
- Documentation: the Agent document requests paragraph in `src/ash/workbench/services/textfile/README.md` and this root record.
- Generic base URI utilities, backend protocol, Search UI, other editor behavior and another worker's checkout are outside scope.

## Identity boundary

The protocol explicitly permits different Windows drive-letter spelling. Comparison therefore normalizes that letter only for local drive file URIs, including its unreserved percent-encoded spelling, retaining encoded path separators and original relative filename spelling. It recognizes a single encoded drive byte only if it is an ASCII letter; reserved characters and the rest of the path are never decoded by this rule. Directory and filename case stays distinct; POSIX paths do not become case-insensitive on a Windows or macOS renderer. Existing URI comparison enforces scheme, authority, query, fragment and directory boundaries. UNC authorities retain existing case-insensitive URI-host comparison; UNC share/path case stays distinct.

There is no server filesystem case-sensitivity metadata in this request. This slice does not infer general Windows, macOS or UNC path folding. `workspaceRelativePath` cannot be reused unchanged because it also applies renderer-macOS-wide file-path folding. Parsing backslash-separated server paths across operating systems remains outside this list-comparison change; `URI.file` uses the renderer's separator rules.

## Acceptance

- Run the original regression and added drive, POSIX, UNC, URI identity, directory-boundary and clean/non-text exclusion cases before changing production, then repeat after the owner fix.
- Run the normal owning frontend test and renderer typecheck entrypoints. If unrelated aggregate errors prevent them, preserve diagnostics and use the repository-supported focused compilation fallback without claiming aggregate success.
- Check formatting and `git diff --check`, review the exact four-file diff, then wait for the parent's serial integration slot. No push before that slot.
- Real Windows server execution and Web/Electron product acceptance are not implied by Linux transport/service tests. Investigate existing product coverage without starting a heavy backend build.

## Results

Validation uses the official pinned Node 24.21.0, pnpm 12.8.0 and Rust 1.98.0 toolchain on Linux. Dependencies were copied into this checkout; the initially absent `native-keymap@3.3.9` package was restored from the existing pinned dependency cache. All protocol, resource and TypeScript outputs were generated in this checkout. Only the protocol exporter was built, with Cargo jobs limited to 2; no complete backend build was started.

- Red, unchanged production: the normal `pnpm run test:unit --run src/ash/workbench/services/textfile/test/browser/appServerTextDocumentHost.test.ts` compiles successfully, passes all 5 runner regressions, then executes 53 owning tests: 48 pass and 5 fail. Failures are exactly the original dirty-text test plus uppercase server drive, uppercase editor drive, drive root and trailing root separator. Each wrongly returns an empty document list. Before the missing package was restored, aggregate compilation stopped on that dependency; focused compilation passed and produced the same red result.
- First-patch green (superseded by the review correction below): the same normal entrypoint passes all 53 owning tests and all 5 runner regressions. Common and aggregate test compilation pass. Localization reports 0 missing entries and icon checking validates 246 outputs. No new warnings were emitted.
- Platform-bridge regression check: the official unit runner was rerun with the supported renderer environment set to macOS and Windows. Before the fix, each environment runs 20 list cases with 3 failures: POSIX directory, drive-directory and UNC path case are incorrectly folded. After the fix, each runs all 20 successfully. These are Linux-hosted renderer-environment simulations, not native Windows/macOS execution.
- Both touched TypeScript files pass `pnpm run format:ts`; both Markdown files pass Prettier; `git diff --check` passes.
- `pnpm run typecheck:renderer` passes, including its normal preparation and common typecheck. No publication has occurred.

The existing product test `Agent document requests preserve unsaved editor content, undo, BOM and CRLF` in `test/smoke/areas/editor/editor-open.spec.ts` includes the real Workbench list request. It requires the prepared App Server product. This checkout has no such backend package, and this task excludes a heavy backend build; Web/Electron product execution and a real Windows App Server remain unrun. The passing owning suite exercises actual protocol decoding/dispatch, service-container creation, text models and the working-copy registry with the existing in-memory transport and file provider.

## Independent review correction

The first patch was not published. Review found that a literal-only drive matcher lost a previously valid match: `C:/workspace` versus `file:///%43:/workspace/Mixed.txt`. Generic URI comparison already normalizes unreserved percent escapes, but the first helper normalized only the root's literal uppercase letter.

Twelve additional regression cases cover the original encoded-uppercase match, reverse drive case, uppercase/lowercase hex spelling for uppercase/lowercase letters, and encoded drive colon/slash, directory slash/backslash and reserved non-letter exclusions. Against the first helper, focused compilation passes and the 32 list cases run with 28 passes and 4 failures; all four failures are encoded uppercase-drive positive cases. The helper now interprets only the initial ASCII drive letter and preserves every other encoded component. Final acceptance completes successfully:

- Normal owning `test:unit` entrypoint: 65 tests passed, plus all 5 runner regression tests; common and aggregate test compilation passed.
- Normal `typecheck:renderer`: passed, including normal preparation and common compilation.
- Linux-hosted macOS and Windows renderer-environment runs: 32 list tests passed in each environment. They do not establish native OS acceptance.
- Touched TypeScript formatting, both Markdown checks and `git diff --check`: passed; no new warnings.
- The first patch is superseded. The same independent reviewer approved corrected patch `faf445df60560ddb2ad22352f4a95cc944e135225663325648863925a87cefaf` with no remaining blocker.
- Integration baseline: `baba5f6f39b7deccafcc3ac7b48c62fc2fcd8bce`. All four paths were unchanged upstream, and reverse apply-check confirmed the approved patch remained exact after the fast-forward. The original drive-letter regression was verified byte-for-byte unchanged. Normal owning tests again passed 65/65 plus runner 5/5, and the normal renderer typecheck passed. This evidence update is the only subsequent change to the reviewed patch.
- Publication uses the parent's authorized serial main slot, the verified `chogng` GitHub identity, and a non-force ref update guarded by the integration baseline SHA. No broader text-file, native Windows or Web/Electron acceptance is claimed.

# Text file service

This module owns the Workbench boundary between resource I/O and editor model
implementations. Cross-editor architecture and Stanza ownership are
canonical in [`docs/editor-architecture.md`](../../../../../../docs/editor-architecture.md).

## Current contract

| Concern | Owner | Status |
| --- | --- | --- |
| Workspace resource reads and atomic writes | `IFileService` | ✅ |
| Bootstrap-text versus file-system resolution | `ITextFileService.resolve` | ✅ |
| Text save transport and cancellation | `ITextFileService.save` | ✅ |
| URI-to-`TextModel` references | `ITextModelService` | ✅, editor-owned |
| Editor model references | Code and Academic TextModel services | ✅, editor-domain-owned |
| Format-specific dirty state, snapshot saves and explicit reverts | Code/Academic TextModel services | ✅, editor-domain-owned |
| Shared working-copy lifecycle and resource indexing | `IWorkingCopyService` | ✅, Workbench-owned contract, editor-owned implementation |
| CRLF/LF source-line-ending preservation | `ITextModelService` | ✅, editor-owned |
| Workspace external-change invalidation, clean reload, and dirty-model conflict state | `IFileService` → `ITextFileService` → `ITextModelService` | ✅, transport notification plus editor-owned policy |
| Pre-write external-change conflict detection | `ITextModelService` | ✅, editor-owned defense in depth |
| Atomic expected-revision writes | `ITextModelService` → file service → App Server | ✅ |
| Crash backup and workspace-scoped recovery | `IWorkingCopyBackupService` / `WorkingCopyBackupTracker` | ✅ |
| UTF-8 validation, BOM handling, binary detection, and safe size limit | `ITextFileService.resolve` | ✅ |
| Binary preview fallback | `workbench/contrib/binaryEditor` | ✅, bounded read-only hex/ascii view |
| Non-UTF-8 decode and original-encoding writeback | future TextFile model layer | 尚未完成；当前明确拒绝且不会静默转码 |

`TextFileService.resolve` validates one `TextFileResolveRequest`, observes cancellation, returns `bootstrapText` without touching the file system, and otherwise checks `IFileService.stat` before one `readFileBytes` call. It rejects resources above the text safety limit, NUL/control-character-heavy samples, and invalid UTF-8; a UTF-8 BOM is stripped and the result records `encoding: "utf8"` plus whether content came from `Bootstrap` or `FileSystem`. `TextFileService.save` validates one `TextFileSaveRequest`, observes cancellation, and delegates exactly one atomic write to `IFileService.writeFile`. `ITextFileService.onDidChangeFiles` forwards coarse App Server filesystem invalidations without introducing a live document cache. A concrete editor decides whether a clean model may reload or a dirty model must retain local text and report a conflict.

This service deliberately does not cache live models. The Text and Document engines have
different transaction and undo semantics, so each editor domain owns its model
identity and reference lifetime. `IWorkingCopyService` indexes the resulting
format-specific working copies without owning their models. `ExplorerView`
passes only a resource and label to `EditorPart`; the selected pane resolves
content through this service and registers its working copy with the shared
Workbench lifecycle.

## Ownership and failure semantics

`Workbench` constructs `TextFileService` after `BrowserFileService`, registers
it as `ITextFileService`, and injects it through `EditorPaneCreationOptions`.
Stanza text and document contributions reject construction when that service is absent.

Cancellation before resolution or save, or while awaiting the underlying I/O, rejects without publishing a result. File-service errors pass through unchanged. `TextFileBinaryError` and `TextFileTooLargeError` are editor-facing classification failures: the open-error pane may offer the registered Binary Editor, but the bytes never enter a text model.

Adding model caches, backup persistence, or conflict policy directly to
`ExplorerView` would signal architectural drift. Dirty state and conflict
policy remain in the editor-domain adapters (`BrowserTextModelService` for the
Text Engine and `DocumentWorkingCopy` for the Document Engine); the shared working-copy contract
exposes their common lifecycle without requiring a second editor model authority.

## Tests and modification impact

`test/common/textFileService.test.ts` covers bootstrap precedence, byte delegation, cancellation, UTF-8 BOM handling, binary/invalid UTF-8 rejection, size limits, and failure propagation.
`../../../platform/files/test/browser/fileService.test.ts` covers App Server
invalidation projection.
`../../contrib/files/test/browser/explorerView.test.ts` verifies that Explorer does not read file
content. Stanza Text Engine model and pane tests cover shared model references, edit
preservation, cancellation, and session disposal. The working-copy service
test covers registration, lookup, and unregistration.

Changing resolution, save, or cancellation semantics requires updating all
three suites plus `docs/editor-architecture.md`. Expected-revision persistence
and backup recovery remain separate contracts with dedicated conflict and
recovery tests.

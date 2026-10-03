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

`TextFileService.resolve` validates one `TextFileResolveRequest`, observes cancellation, returns `bootstrapText` without touching the file system, and otherwise checks `IFileService.stat` before one `readFileBytes` call. It rejects resources above the text safety limit, NUL/control-character-heavy samples, and invalid UTF-8; a UTF-8 BOM is separated from document text and the result records `encoding: "utf8bom"` or `"utf8"` plus whether content came from `Bootstrap` or `FileSystem`. `TextFileService.save` validates one `TextFileSaveRequest`, observes cancellation, and restores the requested UTF-8 BOM and delegates exactly one atomic expected-revision write to `IFileService.writeFile`. The resource adapter carries the resolved encoding to the shared model owner and back on save; it keeps no separate file-format cache. `ITextFileService.onDidChangeFiles` forwards coarse App Server filesystem invalidations without introducing a live document cache. A concrete editor decides whether a clean model may reload or a dirty model must retain local text and report a conflict.

This service deliberately does not cache live models. The Text and Document engines have
different transaction and undo semantics, so each editor domain owns its model
identity and reference lifetime. `IWorkingCopyService` indexes the resulting
format-specific working copies without owning their models. `ExplorerView`
passes only a resource and label to `EditorPart`; the selected pane resolves
content through this service and registers its working copy with the shared
Workbench lifecycle.

`BrowserTextModelService.acquire` holds a reference while awaiting the model's
lexical support and first line, then returns it to the text or diff pane. Its
viewport prepares visible lines before rendering; the remaining document is analyzed
in bounded background batches. Opening a file does not wait for full-document TextMate
analysis. Asynchronous document providers retain their versioned readiness contract.
Cancelling an opener releases only that opener's reference. Models with no token
provider or above the tokenization limit do not wait for analysis.
Semantic tokens and language-server features continue independently.

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

Clean external reloads apply model edits and EOL changes in one undo step, keeping earlier saved edits undoable. Explicit revert still clears the discarded history. The persisted baseline uses the model's normalized text, so mixed line endings do not mark a freshly reloaded document dirty. Saves use the model EOL, including a deliberate user change to LF or CRLF.

## Agent document requests

Code Workbench and Agents windows advertise `textDocuments: { version: 1 }`.
`read_file`, `write_file`, `edit`, `apply_patch` and `grep` use the Rust tool-facing
`TextDocumentEditor` port for a product Turn bound to such a connection.
`AppServerTextDocumentHost` converts generated server requests to the existing
`ITextModelService` and `IBulkEditService`. It owns only snapshot references;
the editor services retain document state, undo, working copies and saves.

Reads include the current unsaved text and return an opaque version-bound lease.
Applying consumes the referenced leases and rechecks versions inside the workspace
transaction. Successful file-tool batches save all affected working copies through
the existing text-file service before reporting success, including earlier unsaved
user text. They retain undo history, UTF-8 BOM and model EOL, so the next command
reads the same saved result. Save failures keep the model and report an unknown
outcome; the adapter does not replay an already applied edit. `textDocument/list`
reads dirty text working copies under the requested root; searches replace each
corresponding disk result with this text without updating the shared index.
Creates use the file service, including missing parent directories. Delete and
move currently require closed resources, as defined by the workspace edit service.
File-operation rollback retains the serialized bytes, including BOM and mixed EOLs.

Connection close and cancelled resolution release references. A closed originating
editor or a lost commit reply fails the tool without switching it to a disk write;
the latter reports an unknown outcome. Clients without this capability and Turns
without a product connection use the explicit disk execution path. Same-directory
child Turns inherit their parent's exact connection before tool workers run. Isolated
checkouts and background executions use filesystem documents; completing the parent
does not discard a running child's binding. Academic does not advertise this text
capability. Chat Editing accept/reject UI is also not connected by this adapter.

`test/browser/appServerTextDocumentHost.test.ts` covers unsaved text, both EOLs,
BOM, undo, version conflicts, reference disposal, creation and file-operation
rollback. The editor smoke tests exercise the production services in Web and
Electron Workbench and Agents windows; the backend suite drives an actual RPC
Agent Turn through read, search, edit, write and a command that reads the saved file.

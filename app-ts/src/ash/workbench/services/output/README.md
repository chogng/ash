# Workbench Output service

`common/output.ts` is the canonical frontend contract for independently
owned Output channels. `contrib/output/browser/outputServices.ts` implements `OutputService` and owns channel registration order, the
active channel, workspace-scoped selection persistence, and channel removal
fallback. Producers own the `IOutputChannel` returned by `createChannel`, append
typed entries to it, and dispose it when that producer disappears.

`OutputChannel` privately owns bounded in-memory retention, sequence assignment,
clear semantics, and content change delivery. It does not know about Panel DOM,
Language Servers, extensions, tasks, or transport DTOs. A duplicate channel id,
unknown selection, invalid severity, or use after disposal fails synchronously.

The browser path is:

1. A producer calls `OutputService.createChannel`.
2. The producer appends `IOutputEntryInput` values to its caller-owned channel.
3. `contrib/output/browser/output.contribution.ts` owns service, command, view,
   and accessibility-help registration. The panel and resource editor acquire
   references to the channel's stable `output:` URI through `ITextModelService`.
   Both display the same read-only text model and receive append, replace, and clear.
   Structured text/severity/category filters belong to the Output service; the panel
   applies them as hidden lines without changing the shared text. Workspace file
   locations are supplied to the editor link registry by `OutputLinkProvider`.
4. Selecting a channel updates the service and persists its id in workspace
   storage; if that producer returns later, the selection is restored.

Language Server event adaptation is owned by
[`../language/README.md`](../language/README.md). It consumes this service like
any other producer. Adding Language Server fields, App Server DTOs, or producer-
specific filtering here would signal an ownership regression.

Executable extensions use the process-fenced stream documented in
[`../../../../../../ash-rs/editor-extension-host/README.md`](../../../../../../ash-rs/editor-extension-host/README.md).
`AppServerExtensionHostService` alone translates those transport events into
caller-owned channels; the generic Output service does not know Host RPC DTOs.

The channel retains bounded entries independently of its resolved text model.
Closing the last model reference disposes the text model; reopening reconstructs
it from those entries. Disposing the producer's channel also releases its model.
Export writes the complete retained text, irrespective of the panel filter.

`services/output/browser/systemOutputService.ts` remains the Window/App Server
log adapter. Shared Workbench services depend on the Output contract, not on the
contribution implementation.

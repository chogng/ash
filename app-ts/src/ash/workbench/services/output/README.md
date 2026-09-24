# Workbench Output service

`common/outputService.ts` is the canonical frontend contract for independently
owned Output channels. `OutputService` owns channel registration order, the
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
3. `OutputViewPane` observes `IOutputService`, projects the selected channel, and
   owns channel selection, filtering, severity/category visibility, smart scroll,
   workspace-confined file links, read-only editor snapshots, export, and clear.
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

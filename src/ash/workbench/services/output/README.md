# Workbench Output service

`common/output.ts` is the canonical frontend contract for independently
owned Output channels. `contrib/output/browser/outputServices.ts` implements `OutputService` and owns channel registration order, the
active channel, workspace-scoped selection persistence, and channel removal
fallback. Producers own the `IOutputChannel` returned by `createChannel`, append
typed entries to it, and dispose it when that producer disappears.

`InMemoryOutputChannelModel` owns bounded in-memory retention, sequence assignment,
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
   applies them as hidden lines without changing the shared text. Ordinary Output
   text filtering matches complete model lines, independently of how producers batch
   or split writes. Log channels match their structured records, including multiline
   continuations. Workspace file locations are supplied to the editor link registry by `OutputLinkProvider`.
4. Selecting a channel updates the service and persists its id in workspace
   storage; if that producer returns later, the selection is restored.

Text queries use comma-separated alternatives and `!` exclusions. Exclusions take
precedence; spaces and `-` are literal. Double quotes protect commas but remain
part of the matched text. Text queries search the displayed content; category
metadata is filtered separately.

`OutputFilterState` alone owns query syntax and the `output.filterState` workspace
value. New input writes syntax version 2. Nonempty saved queries with no version,
or version 1, retain their previous matching behavior only until the first
explicit text edit, clear, or reset. Severity and category changes preserve that
restored syntax. The input's tooltip and accessible description explain restored
queries; normal queries have no migration notice. A newer unsupported version is
left untouched, including writes from another window. This window can apply
unsaved filters, and the input explains that its changes will not be persisted.
Serialization writes only this owner's syntax version, text, hidden severities,
and hidden categories through the existing storage service.

Language Server event adaptation is owned by
[`../language/README.md`](../language/README.md). It consumes this service like
any other producer. Adding Language Server fields, App Server DTOs, or producer-
specific filtering here would signal an ownership regression.

Executable extensions use the process-fenced stream documented in
[`../../../../../../crates/external-ext/README.md`](../../../../../crates/external-ext/README.md).
`MainThreadExtensionApi` translates those transport events and JavaScript editor
callbacks into caller-owned channels; the generic Output service does not know Host RPC DTOs.

The channel retains bounded entries independently of its resolved text model.
Closing the last model reference disposes the text model; reopening reconstructs
it from those entries. Disposing the producer's channel also releases its model.
Export writes the complete retained text, irrespective of the panel filter.

`services/output/browser/systemOutputService.ts` remains the Window/App Server
log adapter. Shared Workbench services depend on the Output contract, not on the
contribution implementation.

Desktop supplies `ILoggerService.files` through its authenticated Main logger
channel. The existing Node `LoggerService` remains the only owner of Desktop
log writes, rotation and session retention. It enumerates those files directly
and returns bounded complete-line reads with a file generation and byte cursor;
the renderer never supplies a filesystem path. Rotated files and previous
sessions remain available through **Output: Open Saved Logs…**.

`SystemOutputService` reads the current Window and Main files into channel caches
instead of appending a second copy from the live log sink. Saved JSON records keep
their original time, severity, category and error context. Current sources are
polled once per second, with a one-MiB read limit and an explicit gap notice on
rotation, truncation or a tail jump. The reader belongs to its channel; channel
disposal cancels its scheduled work and ignores an in-flight response.

The Local App Server source reads the daemon's existing stdout/stderr file. Its
location comes from the daemon's read-only `version` lifecycle command, so
Desktop does not duplicate endpoint-layout rules, parse App Server RPC, start
another backend or copy that log into Desktop history. Raw backend diagnostics
remain raw text; the adapter does not invent severity or original timestamps.
The connection-state channel is separate from this process log. Browser hosts
without saved logs retain their in-memory Window and connection-state channels.

Clear empties the channel cache and discards a pre-clear in-flight snapshot,
while retaining the incremental read cursor. It never truncates a source file. Reloading
reconstructs the view from the retained file tail. Display filters only affect
the view. A descriptor may expose a named producer's logger control; Window's
recording-level menu controls the Workbench logger, while independently owned
loggers in the same file retain their own levels. Historical and raw-file sources
do not advertise recording-level control. Loggers without saved or launch defaults use Info; producers may still select
independent recording levels.

Both Workbench and Agents windows install the shared MainThread extension API
bridge and its domain services, along with `SystemOutputService`,
`AppServerLanguageServerStatusService` and `LogsContribution`. The latter observes
`ILoggerService`'s initial registry, additions, removals and visibility. Logger
identity and recording levels stay with the logger service. Each logger retains
at most 2,000 entries / 512 Ki characters for late subscribers; Output borrows its
sink and never replays that history after Clear. Desktop persistence still uses
the authenticated host log files, rather than accepting arbitrary logger paths.
`services/log/electron-browser/logService.ts` owns Desktop Window logging for
both Workbench and Agents. `NativeLogService` uses the platform recorder for
filtering, bounded replay and child logger lifetime, and owns its Console and
Main IPC sinks. Its root is not a named child logger in the registry;
`SystemOutputService` owns its file-backed `rendererLog` channel. The shared
Window identity and localized label live in `services/log/common/logConstants.ts`.
Output migrates the old `window` selection and tagged category keys once in its
workspace state; unknown filter schema versions remain untouched. The Logs
contribution registers `workbench.action.showWindowLog` to select and focus that
same channel in Desktop and Browser hosts.
Both editors acquire documents through `AppServerLanguageDiagnosticsService`,
so opening a supported file starts the owning language service and its real
messages reach Output through the shared status service.

JavaScript `createOutputChannel` supports the language-id and `{ log: true }`
overloads. Log channels expose the VS Code `LogLevel` enum, severity methods,
`logLevel` and `onDidChangeLogLevel`. Output's recording control filters at the
producer bridge and notifies the exact extension incarnation through its
`outputEvents` registration. Display filters never change that recording level.
Hide closes Output only when the calling channel is active; disposal removes
that producer's channel, logger, pending callbacks and level subscriptions.

`services/log/common/defaultLogLevels.ts` owns persistent default recording levels.
Both renderer hosts read the local UI profile's JSONC `argv.json` before startup
(`ash-userdata:/user/argv.json`; Desktop maps it to its UI profile directory).
`log-level` accepts a level string or an array, for example
`["info", "publisher.extension=debug"]`. Writers use the short names `info` and
`warn`, preserve comments and unrelated fields, and normalize extension identities
to lowercase. Desktop `--log` values and `--verbose` override saved values at
startup; launch overrides remain separate from the initial recorder snapshot so
new windows reread later saved defaults.

Output's **Set Recording Level → Set As Default** persists the selected level
globally, or only for the channel's extension. Existing loggers that still match
the old default follow the new value; explicit producer options and differing
manual levels remain intact. New producers use the current default. External
file edits reload the default model; invalid input keeps the last valid snapshot.
The shared JSON editing service edits and saves the existing file model, refuses
unsaved or invalid documents, and uses the model owner's revision checks. A failed
save retains the model edits and does not publish a new default.

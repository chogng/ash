# Workbench language service

`workbench/services/language` owns product adapters and product-level language
composition. The shared language identity, editing configuration, and provider
registries are separate Editor services; Workbench registers App Server and
product providers into those contracts without subclassing or wrapping them.

`WorkbenchLanguageFeatures` installs JSON providers. App Server, extension-host,
Tree-sitter, codebase-symbols, and LSP
adapters register directly through `ILanguageFeaturesService` registries. Every
registration is disposable and independent of per-document service lifetimes.

The core language service registers only plain text. Product language identities,
file associations, editing configurations and grammars come from `extensions`
through `AppServerExtensionService`; removal releases those registrations together.
Standalone callers explicitly register their languages and editing rules.
File models receive the shared language configuration service and observe registration
changes. Resource detection consults that language service without a second MIME or
suffix table. A directly constructed `TextModel` without language configuration has
no language-specific editing rules and creates no services.

The filename split is intentional:

| Filename family                                                                  | Owner                            | Responsibility                                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/workbenchLanguageFeatures.ts`                                           | Workbench                        | Product-owned JSON provider composition                                                                                                                    |
| `browser/appServer*Providers.ts`                                                 | Workbench                        | App Server DTO-to-Editor provider adaptation                                                                                                               |
| `editor/common/services/languageService.ts`                                      | Editor                           | Language identity and file association                                                                                                                     |
| `editor/common/services/languageConfigurationService.ts`                         | Editor                           | Composable editing rules                                                                                                                                   |
| `editor/common/services/languageFeatures*.ts`                                    | Editor                           | Provider registry contract and implementation                                                                                                              |
| `TextModel.bracketPairs`, model tokenization                                     | Editor model                     | Bracket structure and token data consumed by editing features                                                                                              |
| `editor/contrib/folding/browser/`                                                | Editor contribution              | Folding range providers, tracked fold state, commands, and browser projection; it consumes language configuration but does not own language infrastructure |
| `languageCompletionSession*`, `languageDiagnostic*`, `languageTokenLineIndex.ts` | Editor language layer            | Version gates, session state, and browser-facing result projection                                                                                         |
| `*Provider*`, `*Worker*`, `*Wire*`                                               | Owning Editor or Workbench layer | Editor owns provider/worker contracts; Workbench owns product and transport adapters                                                                       |

The editor language layer still owns the contracts and editor semantics consumed by those
providers: bracket and pair editing, folding state, completion
sessions/snippets, result version gates, and browser presentation. This service
does not move those responsibilities into Workbench.

## LSP boundary

The LSP client and server lifecycle live below the Renderer in
`crates/lsp`, `crates/lsp-manager`, and the App Server. This Workbench
service owns only the frontend adapters in `browser/appServerLanguageProviders.ts`
and `browser/appServerLanguageDiagnosticsService.ts`. The provider adapter exposes
hover, completion, cross-file navigation, call/type hierarchy, workspace symbols,
rename, code actions, document/range formatting, parameter hints, inlay hints,
and linked editing through
editor-owned contracts. The diagnostics adapter
reference-counts open models, debounces authoritative document synchronization,
closes the App Server document after the final editor releases it, and aggregates
push diagnostics with editor-published parser diagnostics by resource and revision.

The editor merges current-revision LSP diagnostics with parser diagnostics in its
existing decoration collection; stale revisions are hidden immediately after an
edit. The Workbench-owned Problems panel enumerates the complete shared workspace
repository, groups diagnostics by resource, filters by severity/message/file,
and delegates row navigation to `IEditorPart`; it does not inspect editor DOM or
own diagnostic production. Document pull reports share the open-model revision
gate; workspace reports are projected through App Server's Workspace filesystem
authority and retain unopened resources in the same repository. Semantic tokens
and the remaining LSP document features use editor-owned provider contracts.
Formatting edits use the editor command/undo layer; parameter hints retain provider-selected active
signatures and parameters; inlay hints remain non-mutating; linked ranges extend
editor input before commit so every synchronized change is one atomic undo step.
Regardless of origin, revision gates, application semantics, and DOM projection
stay editor-owned.

Language-server log and show-message notifications are adapted by the Workbench
language status service. Each server owns a channel registered through the
canonical [`OutputService`](../output/README.md); the generic Output panel owns
channel selection and clearing. The persistent Language Services status entry opens
one shared menu, grouped by workspace folder. Each server offers View Logs,
Restart, and Stop; folder and window batch actions affect already-started servers.
The backend owns process state and controls; stopping retains configuration and
blocks automatic resumption by background language requests. Restart replays open
documents. Discovery reads never install or launch unused servers.

Warnings and complete error details stay in Output. Explicit server errors and
terminal lifecycle failures offer concise, deduplicated notifications with View
Logs and Restart actions. Routine progress and automatic retry never notify. The
menu supports keyboard submenus, accessibility help and an accessible status view,
using `accessibility.verbosity.languageServers` for its hint.

The service adapts each work-done token to a Promise passed to
`IProgressService.withProgress`, reports `IProgressStep` messages, and completes
that Promise on the server's end notification or adapter disposal. Server names
are task titles. Progress messages show the operation and optional percentage
first, followed by server-reported details such as scanned counts or the current
directory.
Reports that omit a detail retain its previous value; an empty detail clears it.
Reaching 100% does not complete an operation. End, stop, terminal failure, or
adapter disposal completes it; concurrent tasks include the remaining task count.
Each running operation registers a temporary Output command consumed through
`IProgressWindowOptions.command`; the registration ends with the task.

`ProgressService` owns presentation routing and incremental progress accumulation.
Window tasks with commands use the status bar; commandless Window tasks use
silent notifications with a 150 ms delay and a status-bar entry that opens the
notification center. Notification tasks use `INotificationService` and the
existing notification model and views. The producer owns the Promise and handles
`onDidCancel`; requesting cancellation never substitutes a completed task. The
shared contract covers the currently consumed Window and Notification locations;
view/composite and Dialog progress are outside this call chain.

The progress implementation and tests use the VS Code paths
`services/progress/browser/progressService.ts` and
`services/progress/test/browser/progressService.test.ts`. The platform layer owns
only the shared progress contract. `appServerLanguageServerStatusService.ts`
remains the Ash-specific App Server notification adapter for both Workbench hosts;
it does not own generic progress presentation. Extension-host progress RPC
(`api/browser/mainThreadProgress.ts`) and active-editor language status
(`contrib/languageStatus`) are separate responsibilities and are not part of this
notification path.

Tree-sitter is composed under `workbench/services/treeSitter`. Captures resolve styles through the current color theme; unsupported languages expose plain text. Diagnostics come from registered language providers.

The frontend reads `language/servers` for each workspace folder and registers the returned language
IDs. `config/changed`, `extensions/changed`, and workspace changes invalidate that snapshot.
Installing a server adds its providers and synchronizes already open documents; removing it clears
its registrations and diagnostics. Pending reports from an older snapshot are discarded. Workspace
requests run once per server rather than once for every language supported by that server.

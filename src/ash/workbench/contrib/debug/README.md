# Workbench Debug

The system-level ownership and current user-visible status are documented in [`docs/debugging.md`](../../../../../docs/debugging.md). This README owns the Renderer implementation contract.

## Current ownership and execution path

This section describes the running Workbench implementation. The confirmed Rust domain migration and frontend ownership split are connected through the production paths described in [the system design](../../../../../docs/debugging.md).

`common/debug.ts` is the canonical frontend contract. `browser/debugService.ts` owns launch/compound configuration, editor-facing breakpoint/Watch facades and the concurrent session collection. `browser/debugTaskRunner.ts` owns Debug task selection, waits and cancellation over the existing Task service. `common/debugViewModel.ts` owns the window's selected session, thread and frame. DebugService selects the initial paused frame and navigates to its source independently of whether Call Stack is instantiated; views submit explicit selections to the same service. `DebugSession` adapts read-only runtime/binding/console snapshots, converts URI/results and invokes host reverse-request callbacks.

Rust owns request pairing, initialization, capabilities, execution state, acknowledged exception choices, breakpoint intent/binding order, inspection jobs, parent-child lifetime and bounded structured output. `DebugWorkspaceStore` owns durable workspace definitions and exception preferences. `common/debugStorage.ts` adapts revisioned snapshots/edits and one-way v1/v2 Memento migration. `common/replModel.ts` keeps only console selection, labels and revisioned read-only snapshots, including retained ended sessions; the backend decides retention.

The window registers its selected DAP process capability, including explicit unavailability, through constructor DI. `IAdapterManager` is the shared registration contract; `browser/debugAdapterManager.ts` owns factories shared by declarative packages, the Extension Host and Debug. `runInTerminal` validates the request and delegates presentation to `ITerminalService`; neither the generic editor nor the renderer becomes a process owner.

`RawDebugSession` calls the Rust client through the selected platform capability. Request IDs, response pairing and deadlines belong only to `ash-debug-client`; `ash-debug-manager` owns its transport resources and runtime state machine. Managed reads carry a revisioned session snapshot; the facade never derives execution state or capabilities from DAP events. Inline IO uses the same backend client. The ordered observation log supplies both tracker directions independently of request completion; shutdown admits retained observations before the stop hook.

Source URI selection belongs to `common/debugSource.ts`. DAP decoding binds physical remote paths and file URIs to the execution authority before asking that owner for a canonical URI. Relative sources remain `debug:` resources with source reference zero and load through the live session; they do not acquire a client filesystem path. The session factory constructs its process, URI identity and logging dependencies through the owning instantiation scope.

The call path is:

```text
DebugService.start / startDebugging / startCompound
  -> editor saveAll and active untitled Save As, unless suppressed or parent-owned
  -> resolveDebugConfiguration providers (type-specific, then wildcard)
  -> Debugger.substituteVariables through IConfigurationResolverService.resolveWithInteractionReplace
  -> resolveDebugConfigurationWithSubstitutedVariables providers
  -> preLaunchTask through ITaskService
  -> prepare DebugSession and publish its stable identity
  -> dispatch-time Debug Adapter descriptor factory, when contributed
  -> DebugSession.start initializes the resolved transport
  -> RawDebugSession / IDebugAdapterProcessService.start
  -> Rust DebugManager creates its client and selected transport
  -> Rust initialize / launch-or-attach / initialized gate
  -> Workbench submits current breakpoint intents
  -> Rust exception filters / configurationDone / launch completion
  -> revisioned Rust execution/capability snapshots
  -> breakpoints + exception breakpoints + configurationDone
  -> session events and inspection requests
  -> disconnect/adapter exit
  -> postDebugTask through ITaskService
```

`DebugBreakpointDecorationProvider` is the only Debug-to-editor adapter. The editor owns a generic composable gutter contract and must not import Debug semantics. `DebugSession` also converts adapter source paths into URIs on the current local or Remote Workspace authority; `DebugService` navigates through that domain resource and never reinterprets a Remote path as local `file://`. Process lifetime, bounded DAP framing, trust retirement, and connection ownership remain backend responsibilities.

Console output is retained synchronously. Output-only change notifications are coalesced
over 16 ms so a DAP burst does not rebuild the console for each message. Session changes
and clearing publish immediately and cancel the pending output notification; disposal
cancels it as well. Keyboard input, focus and output order remain independent of batching.

## Configuration and extension integration

`startDebugging` also accepts a caller-supplied configuration, used by TestingService for an exact compiled test. It does not write `launch.json`; restart retains that configuration. F9 invokes `editor.debug.action.toggleBreakpoint` through the current editor and the same breakpoint owner. LLDB-DAP zero-sequence responses and events retain their adapter identity; request pairing uses `request_seq`, independently of the backend output cursor. Stack frames retain DAP zero line/column values for unavailable positions; inspecting them does not invent a source location. A view opened after a session has stopped immediately reads the existing session.

Each `.vscode/launch.json` configuration can declare an explicit `debugAdapter.program` plus `debugAdapter.args`, or a `debugAdapter.connection` server/pipe endpoint. `debugServer` takes precedence over both explicit descriptors and extension factories and connects to the given local TCP port. If it omits `debugAdapter`, `parseLaunchConfigurationDocument` retains dormant types without invoking providers and resolves already registered defaults through the canonical `IAdapterManager`. Declarative extensions register one caller-owned factory set for the program/argument descriptors contributed through `contributes.debuggers`; other runtime producers use independent registrations. Dynamic factories run after the pre-launch task succeeds or its background matcher reports readiness, so they can inspect the build's adapter artifact. A failed build or error diagnostics prevent both descriptor invocation and adapter startup.

All remaining configuration properties are forwarded to the adapter after `Debugger.substituteVariables` resolves `${env:NAME}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${command:...}`, and `${input:...}` through the shared `IConfigurationResolverService.resolveWithInteractionReplace`. Named folder selectors such as `${workspaceFolder:server}` use the current Workspace folder names. Resolution fails before task or adapter execution when a referenced folder is unavailable. The source configuration remains unchanged for restart; the executable, adapter arguments, launch arguments, and pre/post task references are resolved into a separate execution snapshot. A command or configured input variable is evaluated once per invocation and reevaluated when a new session starts. Inputs come from the selected folder’s `.vscode/launch.json` through FileService; launch arguments do not include the document’s input definitions. `promptString` and `pickString` reuse Quick Input; command inputs execute their declared command with `args`. Cancellation by Escape, workspace change, or resolver disposal closes the owned prompt and prevents startup. Cancellation prevents both pre-launch tasks and adapter creation; invalid resolved executables fail before either side effect. The value comes from the current Workspace URI: native filesystem syntax for `file:` and decoded POSIX syntax for Remote. Workbench-only `preLaunchTask` and `postDebugTask` fields are removed before the DAP launch/attach request. Compounds resolve configuration IDs, unique names, or `{ name, folder }` references and may request `stopAll` behavior. Every reference is validated before the compound pre-launch task runs.

`DebugAdapterFactoryRegistry` accepts static executables and asynchronous `createDebugAdapterDescriptor` callbacks. Dynamic types remain discoverable without calling a provider or allocating a process. At dispatch, DebugService resolves configuration variables, then the Host-broker provider receives `{ configuration: { name, type, request, ...arguments }, session: { id, workspaceFolder }, dirId? }` and returns `{ program, arguments }`. MainThreadExtensionApi binds the callback to its admitted registration, activation generation and incarnation; replacement or disconnect revokes it. DebugService cancels all pending callbacks on workspace change or disposal. Removing a provider or factory cancels only callbacks bound to that registration; unrelated launches and configuration discovery retain their lifetime. A selected factory is checked again after the pre-launch task and before descriptor invocation, so a retired factory cannot start an adapter. Invalid descriptors prevent adapter startup. Descriptor callbacks run after the pre-launch task, so their result cannot prevent a build that has already completed. Restart resolves the descriptor again. The existing Rust DAP transport owner starts the resulting executable or connects to the returned server/pipe endpoint. The standard `DebugAdapterServer` and `DebugAdapterNamedPipeServer` classes map to this same path; connected descriptors keep executable fields absent. The Host RPC and standard facade share session handles and tracker delivery. Inline descriptors create an opaque SDK handle and bind finite send/read/close callbacks to the same prepared session. The session owns that IO before tracker startup and releases it on startup failure or cancellation; a late descriptor from a retired creation lifetime is closed. Session options beyond the documented supported contract remain outside this migration.

The shared configuration resolver exposes non-interactive `resolveAsync` and interaction-capable `resolveWithInteractionReplace`. Command aliases use the resolver port, and commands receive the configuration after workspace-folder substitution. Root `windows`, `osx` and `linux` overrides select the execution host before references are collected; platform blocks are removed from the resolved copy, while the original remains available to providers and restart. Object keys and nested replacement values are resolved from the expression's invocation-local cache. Environment lookup batches current unresolved names on the authorized execution host; nested values can introduce another batch. Missing names become empty strings. Raw shell syntax remains data. Pending reads cancel on workspace change or disposal before command variables can execute. Configuration-target selection beyond folder files, contributed variables remain unimplemented; other placeholders remain unchanged. Web and Electron use the same typed backend query. Inherited values retain the backend environment allowlist policy.

## Durability and failure semantics

`common/debugStorage.ts` owns the Workbench persistence boundary and one-way
migration; `DebugService` owns session composition and the editor-facing facade.
Definitions are owned and persisted by Rust `DebugWorkspaceStore` in the profile's
`state.sqlite3` database, keyed by the Workbench Workspace ID, independently of
session, directory or Project IDs. The frontend submits identity-based edits via
`debug/workspace/read` and `debug/workspace/write` through the existing Debug
capability and renderer protocol client. Source IDs/columns, enabled state,
conditions, function log messages, persistent data metadata, ordered Watch
expressions and exception selections survive reload. A revision conflict preserves
the saved target and the local draft; it is reported instead of overwriting another
window. Other windows read revisioned snapshots; no mutation is replayed after a
lost connection. Shutdown joins pending writes before releasing the connection.

The legacy `memento/debug.workspace` v1/v2 decoder runs only at workspace opening.
Rust imports into an absent or equal target and records a digest in the same
transaction. Workbench removes the exact source only after acknowledgement and only
while its captured workspace remains current. Conflicting/invalid sources remain
untouched. An interrupted cleanup can safely resume after newer Rust edits. Normal
edits never write Memento or read it as a fallback. Queued edits retain their original
workspace on a scope switch, and old replies cannot publish into the new facade.

Verification, stack/variable/Watch values, live sessions, nonpersistent data points,
instruction addresses and Console output remain transient. The session owns its
addresses; releasing it removes them. Editor models, dirty buffers, Tasks, Terminal,
configuration callbacks and UI selection retain their existing owners.

The Breakpoints section edits expressions with F2 or its row action, and supports individual and bulk enable/disable and removal. Conditions and log messages are passed unchanged to DAP; their expression syntax belongs to the selected adapter. Unsupported breakpoint options produce an unverified point with a reason and are excluded from the adapter request. Each session serializes complete source and additional-family replacements, and discards verification replies for points edited or removed while a request was pending.

`ConfigurationManager` in `browser/debugConfigurationManager.ts` owns the launch catalog and selected configuration for the Debug service lifetime. `DebugService` publishes discovery results to this manager and reads the same catalog when starting a session; view recreation never resets the selection. Catalog replacement reconciles the selected ID to the current object and falls back to the first remaining configuration or compound.

`DebugViewPaneContainer` in `browser/debugViewlet.ts` owns the container title actions. The Part asks its `getActionViewItem` for `StartDebugActionViewItem` from `browser/debugActionViewItems.ts`; that item presents Start and the searchable configuration dropdown without retaining another selected ID. `browser/media/debugViewlet.css` owns this presentation, and `browser/debugIcons.ts` registers its semantic icons. The shared start command and the configure command in `browser/debugCommands.ts` read the manager, so F5, the menu, the title launcher, and opening the selected folder's launch.json agree. The title launcher explicitly starts a new session; F5 retains Continue behavior for a paused session.

`debug.contribution.ts` registers Welcome, Variables, Watch, Call Stack and Breakpoints independently. `DebugViewPaneContainer` projects their presentation conditions and measures inline chrome; the generic container owns pane creation, visibility, keyboard resizing, retained drafts and collapse/size storage. `browser/debugToolBar.ts` owns inline session selection, actions and localized status. `browser/welcomeView.ts` owns welcome content and cancels configuration requests when hidden. Each inspection pane owns its controls, asynchronous reply lifetime and editing; errors go to the window notification service. `common/debugViewModel.ts` owns coherent session/thread/frame focus and assignment-driven view invalidation. `Repl` owns the Panel destination, session selector, clear action, accessible output and REPL input. Keeping this presentation separate prevents DAP output from being mislabeled as an Output channel or mixed into Terminal PTY bytes.

DebugService selects the default paused frame and opens its source independently of pane creation. Call Stack displays threads/frames and submits explicit selections through the asynchronous `focusStackFrame` contract; it no longer opens source editors. DebugService uses the existing canonical source URI, text-model resolver and editor owners for local, Remote and adapter-owned sources. Adapter source resolution holds a model reference and checks the session, selection and workspace lifetime before opening a read-only editor. Variable and source requests run independently, so a source-opening failure reports through notifications without clearing the selected frame or hiding variables. Continuing, switching sessions, frames or workspaces, or disposal retires pending results. Implicit frame updates preserve an active Disassembly editor; explicit frame selection may open source.

The generic `ViewContainerModel` owns visibility preferences in profile UI storage under `<containerId>.state.hidden`, with machine target and entries `{ id, isHidden }`. Preferences survive reload and workspace changes within the same profile, remain isolated across profiles, and preserve choices for views registered later. Context conditions only project active views and never overwrite a user preference. Storage events reproject the model; malformed or oversized tables retain the last valid snapshot, and removing the key restores descriptor defaults. Non-toggleable views remain visible. There is no older durable visibility artifact to migrate. Pane sizes and collapse state retain their existing container storage owners; Debug adds no second visibility state.

Variable editing requires `supportsSetVariable`, a stopped session, and an editable variable. F2 or double-click opens the shared `InputBox`; Enter submits and Escape cancels before submission. The DAP address is the **parent** `variablesReference` plus the variable name, not the variable's child reference. A successful response replaces the displayed value/type/child reference, retires expanded descendants, refreshes Watch, and restores row focus. An omitted response `variablesReference` means a scalar value. Adapter errors retain the draft with accessible validation. Retiring a pending edit discards its UI result without canceling the adapter mutation.

Pre-launch tasks must finish with `succeeded`; missing, ambiguous, failed, canceled, or status-unknown tasks prevent adapter launch. Post-debug task failures are reported without reviving the terminated session. Compound startup rolls back sessions already started when a later configuration fails. Extension adapter removal clears launch candidates before reparsing so stale commands cannot be launched.

An integrated `runInTerminal` request requires the created instance to be running before writing its command. An unavailable instance is closed and the reverse request receives a failure response; no command is retained for connection recovery. The error uses the current display language, and the user can restart debugging.

## Tests and modification impact

Run the Debug tests with the desktop unit runner, or target the compiled files under `contrib/debug/test`. `debugSession.test.ts` covers DAP capabilities, inspection, and variable assignment requests. `debugService.test.ts` covers persistence, task lifecycle, compounds, multiple sessions, and canonical factory resolution. `repl.test.ts` covers hidden-panel capture, evaluation, terminated-session retention, and clear. `debugAdapterManager.test.ts` covers multi-producer ownership and atomic replacement. `debugConfigurationManager.test.ts` covers explicit and extension-resolved adapters. `contrib/debug/test/browser/debugViewPane.test.ts` covers inspection lifetime and variable editing. The Playwright `debug.integration.spec.ts` exercises real editor positioning, input focus, validation, localization, narrow layout, and light/dark/high-contrast themes. `test/smoke/areas/debug/debug.spec.ts` exercises the Code product with a deterministic stdio DAP peer.

Debug-specific behavior in the generic editor, direct process execution in the Renderer, deriving Remote authority inside a Debug view, or live-session data in workspace persistence would signal ownership drift. Moving DAP execution to Rust follows the system design's migration boundary and must retire the corresponding TypeScript execution owner in the same behavior slice.

`DisassemblyViewInput` selects the central `DisassemblyView` editor. Call Stack and the Open Disassembly View command open it for an adapter advertising `supportsDisassembleRequest`. It follows the focused paused frame, browses 50-instruction windows, jumps to addresses, displays bytes and symbols, opens local/Remote/adapter-owned source locations, and toggles instruction breakpoints with F9. DAP byte offsets and instruction offsets remain distinct. Active disassembly retains editor focus across pauses; F10/F11/Shift+F11 send `granularity: instruction` only when the adapter supports stepping granularity. Continuing, changing frames/sessions, clearing input, or disposing the pane invalidates pending disassembly replies. Accessible Help/View and `accessibility.verbosity.disassembly` share the Workbench accessibility path.

`registerDebugConfigurationProviders` binds callbacks to an owned, replaceable registration. Initial templates are validated before `WelcomeView` requests creation of a launch document. Both trigger kinds participate in launch resolution; type-specific callbacks precede wildcard callbacks. Replacement or retirement of an existing provider, workspace replacement, or service disposal abort pending calls. Adding a provider retains unchanged owners and does not revoke an in-flight launch. An undefined resolution cancels startup before Tasks or adapter creation. A null resolution also opens the selected workspace folder’s launch.json through the shared configure command, preserving existing content and focus. Both resolution stages retain the distinction through an explicit Host result envelope. The extension startDebugging call resolves false for a provider cancellation; cancellation of the invocation itself still rejects. Folderless resolution has no folder launch file to open. Provider changes are reevaluated for a new session or restart, and the original configuration stays unchanged. The Host bridge forwards the canonical folder URI, name, and index rather than reconstructing a folder from a path.

## Current limitations

Function creation uses the Breakpoints toolbar. Data creation queries `dataBreakpointInfo` with the variable parent reference and selected frame, then offers only the adapter-supported read/write/readWrite access types. Instruction creation uses the selected frame instruction reference with an editable byte offset. The respective DAP replacement requests are capability-gated; session addresses are never sent to another session. Adapters use stdio processes, TCP servers, named pipes or inline implementations. Live session recovery is unavailable. Expression and filter histories survive window reloads in workspace UI storage; retained output belongs to the backend connection lifetime. Declarative debugger discovery is supported, while arbitrary VS Code Debug extension APIs require the separately planned full Extension Host boundary.

Tasks and Debug share ConfigurationResolverService for environment, workspace, command/input, scalar configuration, user-home and selected-folder cwd variables. Paths and separators follow the execution host through PathService; nested command and configuration references resolve through the same expression. Active-file paths and metadata, selected text, and cursor line/column use one snapshot of the canonical Editor and CodeEditor owners before host reads or interaction. `${workspaceRoot}` and `${workspaceRootFolderName}` use the same Workspace resolution as their current equivalents. Debugger `variables` declarations map `${command:alias}` to their contributed command through the shared resolver. The selected debug type supplies the mapping after provider redirection; repeated aliases run once per start, restart reads the current catalog, and cancellation stops before pre-launch Tasks or adapter creation. Metadata-only debugger declarations retain mappings independently of adapter factories. Folderless `${cwd}` and editor installation paths still require additional execution context.

`runInTerminal.env` shares the terminal spawn contract with Tasks: strings override the child environment and `null` removes inherited keys. Environment values do not enter Shell command text. Executable adapter descriptors also accept child cwd and environment overrides; cwd stays beneath the authorized root. Web and Electron retain the selected directory identity for subsequent transport operations. An adapter initialized after workspace change or service disposal is disconnected before publication.

Pre-launch and post-debug tasks use TaskService's shared exit/readiness wait. Background
compilation can become ready while the process stays alive; error diagnostics still
prevent adapter startup. Cancellation stops the wait and its task. Catalog refreshes
do not revoke the immutable launch snapshot; workspace and factory retirement do.

Session disposal closes its adapter process once, including direct DebugService disposal and late initialization after workspace retirement. Compound stop listeners belong to the member session records and are released when those sessions finish.

## Current Debug capability boundary

| Contract area              | Current behavior and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and adapters | Static executables, Host RPC asynchronous descriptors, variable resolution and folder-qualified compounds are implemented. Configuration providers resolve before and after variable substitution; Initial providers supply launch.json templates. The Select and Start command merges configured entries with Dynamic provider results, preserves workspace-folder identity and cancels discovery when the picker closes or the workspace changes. Configuration discovery activates onDebug and the requested Initial/Dynamic phase; launch activates onDebug and the selected type’s onDebugResolve before taking its provider lifetime. Dormant owners are admitted and started by the App Server Host with their exact activation generation. A redirected type activates its dormant owner before parsing and invoking the target callbacks; unchanged provider and factory owners retain their identity across that activation. Later extension registration remains incomplete. |
| Session and extension API  | Stable session identity, name updates, start/end/active/custom events, custom requests, source/function breakpoint APIs and per-session DAP breakpoint queries are implemented. Adapter tracker factories and their six lifecycle/message hooks are implemented. Parent identity, managed lifecycle, `noDebug`, console merging and stack-item events are implemented; other session options and the complete namespace remain incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Transport and recovery     | Stdio process, TCP server and OS named-pipe ownership, cancellation and disposal are implemented. Connections share DAP framing and bounded output with processes; close awaits reader cancellation and writer shutdown. Inline adapters use the same Rust request client through bounded Host IO queues and awaited implementation cleanup without spawning an adapter process. DAP startDebugging reverse requests create independent child sessions through the same configuration, task and adapter owners. Live session recovery remains incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tasks integration          | Startup/shutdown share TaskService, background matcher readiness, diagnostic failure checks and cancellation. Contributed matcher/pattern registries are implemented; broader task presentation, file-location search and run policies remain incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Ash uses its own `@ash/sdk` extension contract. The retained Host bridge below describes implemented operations; complete VS Code extension API compatibility is outside the adopted product target.

`MainThreadDebugService` exposes the canonical DebugService through authenticated
session, custom-request, name and breakpoint operations. The `debugEvents`
registration requires the debug-adapter capability. Ordered queues are bounded to
64 callbacks and belong to one extension incarnation. Custom DAP events are observed
before initialization completes; termination follows adapter close acknowledgement.
The retained Debug Host bridge preserves session and breakpoint object identity,
start/end/active/custom events, start/stop calls, `DebugSession.customRequest`, mutable
session names, source/function breakpoint constructors, breakpoint change events,
and `getDebugProtocolBreakpoint`. Missing DAP bodies remain distinct from JSON null.
Source breakpoint IDs and columns survive workspace persistence. DAP bindings belong
to each session and are discarded for removed, disabled or edited breakpoints; adapter
changed breakpoint events update those bindings without rewriting the user's source position.
Adapter-created source breakpoints enter the same catalog and extension change events,
with their protocol binding available before notification. Adapter removal deletes the
matching catalog entry without echoing an update to the originating adapter. Sources
with a source reference remain bound to that session; later user removal sends an empty
setBreakpoints request using the source reference, including points without a protocol ID.
`registerDebugAdapterTrackerFactory` supports multiple factories per type and `*`.
Factories receive the same prepared session as descriptor callbacks and subsequent
session events. All factories share a one-second creation deadline; rejected or
late trackers do not prevent launch, and late handles are disposed. The session
owns accepted trackers, so unregistering a factory preserves active hooks.
Outgoing `onWillReceiveMessage` and incoming `onDidSendMessage` observations share an
ordered queue without blocking DAP sends or response pairing. Observation callbacks do
not transform protocol messages. A callback can await another custom request even when
that request's observation is queued behind it. Each callback has a one-second deadline;
expiry retires and releases that tracker, while other trackers and the session continue.
Startup and shutdown hooks share that deadline, and disposal cancels observation waits.
Shutdown allows one second to drain message observations. If they remain queued, the
pending observations are skipped with a diagnostic; the current callback still settles
before the stop hook, so a slow backlog cannot hold adapter cleanup indefinitely.
`onWillStopSession` precedes process close, and `onExit` follows close acknowledgement.
Exit codes are supplied only when reported by the process reader. The message queue
permits 2,048 pending observations across both directions; overflow stops message observation and reports an error. Errors retain
Error identity at the public facade; forced owner retirement revokes callbacks
and releases handles. Executable, TCP, named-pipe and inline transports share the same Rust request owner and Workbench session identity. UI suppression and test-run linkage remain gaps.

The executable descriptor callback receives the prepared session's stable ID and
canonical workspace-folder metadata. DebugSession is created before the
factory callback; the same ID is used by later custom/start/end events. Its public
identity is independent of the backend process handle. A failed factory retires the
prepared session without spawning a process. The source configuration remains
available for restart; extension inspection uses the resolved launch snapshot.

Session launch options accept a canonical `parentSession`, `lifecycleManagedByParent`,
`consoleMode` and `noDebug`. The standard facade also accepts a parent session as the
third argument. Parent references are validated before launch and retained in factory,
tracker and event snapshots. Managed child stop/restart requests route to the parent;
parent release closes its descendants. `noDebug` inherits from the parent unless
explicitly overridden and disables source, function, data, instruction and exception
breakpoints. Shared consoles retain each adapter's output once and evaluate against
the currently selected live session. Separate child consoles keep independent history.

An explicit extension launch without a workspace folder retains `workspaceFolder`
as undefined through provider, factory, tracker and event APIs, even when the window
has open folders. Absolute adapter/source paths and host environment variables work
without a folder. Unqualified workspace variables still require an explicit folder;
named configuration launch selects one current configuration and rejects ambiguity.

DAP reverse `startDebugging` requests use DebugService to launch the same debugger type with a canonical parent and no selected workspace folder. Child sessions retain the public defaults of independent lifecycle requests and a separate console; `noDebug` inherits from the parent. A parent that fails initialization also releases children started by reverse requests before its launch response.

A registered descriptor factory returning `undefined` or `null` supplies no adapter.
The Host bridge accepts JSON `null` as this empty result; the session fails with a
localized error before trackers or process startup, ends its prepared session, and
does not use the declarative default as fallback. Other malformed descriptor values
remain boundary errors.

Debug startup calls `common/debugUtils.ts::saveAllBeforeDebugStart` through `IEditorService` and retained `EditorGroupView` panes before activation, providers or preLaunchTask. The active editor pane supplies its owning group; no unrelated group is substituted for an untitled input. `debug.saveBeforeStart` selects no saves, file-backed saves, or file-backed saves plus active untitled Save As. A cancelled Save As, a dirty result, a save failure, or a workspace change prevents adapter launch. Child sessions do not repeat the parent save; extensions can use `suppressSaveBeforeStart`. The editor owns save participants and read-only recovery; Debug never writes dirty buffers directly.

The current inspection chain is `CallStackView` / `VariablesView` /
`WatchExpressionsView` → `IDebugSession.inspectStack`, `inspectFrame`,
`evaluateWatchExpressions` (or child `variables`) → `RawDebugSession`
→ platform domain capability → connection-owned App Server service → Rust manager.
The view no longer sequences threads/stack/scopes/variables/evaluate requests.
`common/debug.ts` remains the frontend contract; generated transport DTOs stay in
the platform adapter. These are responsibility slices in the existing VS Code
counterpart files. The four inspection panes and window-owned ViewModel now
close the production inspection call chain; this is not a claim of arbitrary
debugger-extension compatibility.

The Rust query checks `inspectionRevision` before issuing DAP, and fences both
continuations and retained completions. Selection and editor focus are client-owned.
Breakpoint snapshots carry an edit version and pending/confirmed status. The facade
cannot rebuild bindings or replay replacement requests; generic family request
bypasses are refused by Rust. Adapter-originated catalogue changes are published
only after the backend binding exists, preserving extension observer ordering.

The Rust session registry owns live exception selection, prepared/runtime
parent-child lifetimes and structured console retention. `debugService.ts` keeps
Workbench launch/configuration/Task callbacks and canonical extension handles;
`debugSession.ts` reads runtime facts and output snapshots. `rawDebugSession.ts`
keeps typed calls and inline IO. A revoked admission cannot acquire a late adapter.

The former `debugConsoleViewPane.ts` moved to `repl.ts` with user approval.
`common/replModel.ts` selects consoles, reads the shared frame focus and caches backend revisions;
`replViewer.ts` owns the async data source, row DOM/source controls and accessibility text;
`media/repl.css` owns console styles. `browser/replFilter.ts` filters immutable
backend entries, while the shared `workbench/browser/parts/views/viewFilter.ts`
owns its input, history and count badge. Includes use case-insensitive ordered
matching with comma alternatives; exclusions win. Matching descendants retain
their group context. Visible content and accessible text follow filtering and
disclosure state, without editing the Rust output log.

`browser/linkDetector.ts` owns text-link detection and activation for the REPL
renderer. Web/mail links use OpenerService; file links require FileService stat and
open through EditorService with their line/column and optional side-group target.
The row supplies the listener/hover lifetime and a folder captured from its live
originating session. Remote paths keep that folder's authority. Missing folders
leave bare paths as text; an ended console recreated without its execution context
does not guess a local root. Existing retained rows keep their captured resource.
Row disposal and workspace replacement discard late stat replies and block subsequent activation.

Repl uses `HistoryNavigator` for bounded workspace expression history; the
filter widget uses `HistoryInputBox`. The `debug.repl.history` and `debug.repl.filterHistory`
keys are workspace MACHINE state, each limited to 100 values and validated at
the persistence boundary. Clearing output preserves history and draft navigation.
Completion consumes arrows before history; Enter/Tab insert, Escape dismisses,
and accepting a suggestion does not evaluate it. The selected session/frame calls
`IDebugSession.completions` through Rust request pairing. Cancellation and execution
epochs prevent stale targets from reaching the input; DAP edit ranges use UTF-16.

`Repl` extends the shared `FilterViewPane` in `viewPane.ts`. One filter widget
moves between title and body without losing query, selection, focus or history.
A real `CodeEditorWidget` and owned `TextModel` provide multiline input, selection,
undo/redo, automatic height and first/last displayed-line history navigation.
`getReplInput()` returns that editor. Shift+Enter inserts a line; Enter accepts a
suggestion before evaluating. DAP edits are relative to the cursor’s model line.
The existing `AsyncDataTree` owns output focus, expansion, stable row identity and
lazy variable children; `ReplDataSource` reads immutable Rust entries and requests
variables with their originating inspection revision. Accessible output reads
visible tree elements independently of DOM rendering.

The interaction slice follows existing Ash owners rather than upstream private
implementation structure:

| Corresponding file                                                         | Relationship at slice start | Production caller and responsibility                                                                                        |
| -------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `browser/repl.ts`                                                          | Both repositories           | Debug contribution creates the pane; it owns input, selection, keyboard arbitration and visible content.                    |
| `browser/replFilter.ts`                                                    | VS Code only                | Repl calls the pure filter against immutable Rust entries; it retains only query terms.                                     |
| `workbench/browser/parts/views/viewFilter.ts`                              | VS Code only                | Repl creates FilterWidget through DI; it owns filter input, bounded history and the count badge.                            |
| `workbench/browser/parts/views/media/views.css`                            | VS Code only                | FilterWidget imports its independent component styles.                                                                      |
| `browser/media/repl.css`                                                   | Both repositories           | Repl owns the console layout and suggestions; all colors use registered Ash tokens.                                         |
| `common/debug.ts`, `browser/debugSession.ts`, `browser/rawDebugSession.ts` | Both repositories           | Repl calls the typed session completion contract; the facade validates adapter items and delegates requests/cancel to Rust. |

Input/filter histories are workspace UI state with no older source to migrate.
The existing breakpoint/Watch Memento migration remains in `common/debugStorage.ts`.

## VS Code file ownership audit (2026-10-21)

The initial production inventory had 30 shared paths, 64 upstream-only paths and
five Ash-only code/style paths. At the start of the Console-link slice it had 41 shared paths, 53 upstream-only
paths and one Ash-only code/style path. The 53-path review below accounts for
every difference; six added counterparts leave 47 shared, 47 upstream-only and
one Ash-only path. README files and tests are excluded. These counts
measure file presence; they do not assert complete API or behavior parity.

| Migrated counterpart                    | Production owner and callers                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/debug.service.contribution.ts` | Owns the existing registration loaded by Code and Sessions; service construction order and window lifetime are preserved.                                                   |
| `browser/debugEditorActions.ts`         | Owns editor breakpoint/disassembly actions; existing `debugCommands.ts` owns session and Console commands.                                                                  |
| `browser/replAccessibilityHelp.ts`      | The contribution registers Console help over the existing Repl focus owner and localized text.                                                                              |
| `browser/replAccessibleView.ts`         | The contribution registers the filtered/live Console projection and focus restoration, borrowing Repl's content-change event.                                               |
| `browser/welcomeView.ts`                | Owns welcome content, workspace updates and the cancelable configure request; the registered view model controls visibility; hiding the view cancels its configure request. |
| `browser/media/debug.contribution.css`  | Owns existing editor gutter styles imported by BreakpointEditorContribution. Sidebar styles moved to existing `debugViewlet.css`.                                           |
| `browser/debugTaskRunner.ts`            | DebugService delegates task selection, completion/readiness waits and cancellation; Tasks owns execution and terminal resources.                                            |
| `common/debugUtils.ts`                  | DebugService uses `saveAllBeforeDebugStart`; Editor owns dirty buffers, save participants and Save As.                                                                      |
| `browser/debugToolBar.ts`               | The container creates one DI-owned child owning the session selector, localized status, action state, DOM and subscriptions.                                                |
| `browser/media/debugToolBar.css`        | Owns inline controls and status layout/visibility, with the existing DOM classes and theme tokens.                                                                          |

The user approved responsibility-based migration of the original five Ash-only
paths. Exact deletion was confirmed for `browser/debugActions.ts`,
`browser/media/debug.css`, `browser/media/debugBreakpointDecorations.css` and
`browser/debugViewPane.ts`; production imports and tests were migrated before removal.
Only the disassembly stylesheet remains below.

### Independent view contracts

The following 20 contracts close the registered-pane and cross-pane interaction
chain. They count responsibility/caller changes, not newly created counterpart
files; that slice left 54 upstream-only paths. The subsequent Console text-link
slice reduced that inventory to 53; all 53 are accounted for in the review below.

| #   | Contract                       | Unique owner and observable result                                                                                  |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Variables registration         | `debug.contribution.ts` registers `workbench.debug.variablesView` directly.                                         |
| 2   | Watch registration             | The registry creates `workbench.debug.watchExpressionsView` without parent callbacks.                               |
| 3   | Call Stack registration        | `workbench.debug.callStackView` participates in framework visibility and focus.                                     |
| 4   | Breakpoints registration       | `workbench.debug.breakPointsView` owns one retained edit form.                                                      |
| 5   | Welcome registration           | `WelcomeView.ID` is a real view; a sole view uses the existing merged Part title.                                   |
| 6   | Inspection/welcome membership  | The container projects `debugUx` from the existing configuration/session owners.                                    |
| 7   | Breakpoint-only membership     | `breakpointsExist` includes source, function, data and instruction definitions.                                     |
| 8   | Pane layout and retained UI    | The framework owns one PaneView, keyboard sashes, collapse/sizes, profile visibility and hidden drafts.             |
| 9   | Data-breakpoint request        | Variables invokes a command that reveals Breakpoints and focuses its access editor.                                 |
| 10  | Instruction-breakpoint request | Call Stack invokes a command that reveals the instruction editor with the selected address.                         |
| 11  | Pending reveal lifetime        | Commands validate boundary arguments and reject stale frame/session results after asynchronous reveal.              |
| 12  | Assignment notification        | Variables publishes a successful assignment through `IViewModel.updateViews()`.                                     |
| 13  | Watch invalidation             | Watch subscribes to `onWillUpdateViews`; its pending replies remain frame/session scoped.                           |
| 14  | Default inspection selection   | DebugService selects the initial paused thread/frame and opens source without requiring a Call Stack instance.      |
| 15  | Selection retirement           | Thread/state, session/workspace changes and explicit focus retire old selection/source replies, including zero IDs. |
| 16  | Pane error feedback            | Each independent pane uses the window notification service; edit validation remains in its editor.                  |
| 17  | Inline chrome and status       | DebugToolBar owns localized status and controls; the container measures only their occupied height.                 |
| 18  | View focus commands            | The four standard focus commands open the container, reveal/expand their view and use framework focus.              |
| 19  | Start command target           | F5 opens the Debug container rather than focusing a retired combined view.                                          |
| 20  | Hidden welcome cancellation    | Hiding Welcome cancels pending configuration discovery and prevents a late write/open.                              |

All corresponding production TypeScript/CSS paths touched here were present in
both repositories at this batch's start; no missing counterpart file was added.
The only Ash-only production path touched was the approved removal of
`browser/debugViewPane.ts`. Browser/unit fixtures and the Debug, empty-window and
Rust-testing smoke callers now enter through the production registry/container.

### 53-path responsibility review

2026-10-21 复核纠正：此前“30 个不适用”的结论撤回。没有调用方、缺领域端口、未注册设置或当前未启用，均不能证明功能不适用。原 30 项现为 14 项功能补齐、8 项由已有图标系统承接、8 项真正不适用；`common/debugLifecycle.ts` 另补退出确认。完整 53 项现为 20 项补齐、25 项已有承接、8 项不适用。数量是审计结果，完成证据是下述真实调用和验证。

证据顺序为本地调用方/owner → 上游公开契约及直接调用方 → 本地行为验证；没有复制上游实现。上游基线为本地只读检出 `924c808fbab`，原 53 项已保存于 `/tmp/ash-debug-audit-baseline.json`，用于集合复核。

| 上游相对路径                                    | 处理结论 | 本地承接位置／不适用依据                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/baseDebugView.ts`                      | 已有承接 | `variablesView.ts` 的稳定按钮行和编辑表单、`watchExpressionsView.ts` 的草稿/结果、`replViewer.ts` 的 AsyncDataTree 分别拥有 DOM 与释放；没有上游 mutable Expression/tree-template 公共端口，不新增无调用方的抽象基类。                                                    |
| `browser/breakpointWidget.ts`                   | 已有承接 | `breakpointsView.ts` 的 `openEditor`/表单直接编辑同一 DebugService 断点目录；条件、命中次数、日志与错误验证已有测试。Ash 使用可保留的侧栏表单，未采用编辑器 ZoneWidget。                                                                                                  |
| `browser/callStackEditorContribution.ts`        | 本次补齐 | `debug.contribution.ts` → editor contribution → 当前 ViewModel 帧 → TextDecorationCollection；同资源暂停帧高亮和独立 gutter，恢复、换帧、换会话、释放时清理。只实现被当前调用方使用的投影。                                                                               |
| `browser/callStackWidget.ts`                    | 不适用   | 职责边界：上游直接消费者是 Testing 错误结果内嵌 CustomStackFrame，不是 Debug Call Stack。Ash Debug 的独立 pane 保留 callStackView owner；此结论不声称 Testing 的内嵌堆栈功能已实现。                                                                                      |
| `browser/debugANSIHandling.ts`                  | 本次补齐 | `replViewer.ts` 的真实输出行调用 `handleANSIOutput`；独立解析 SGR、16/256/RGB、强调和 reset；控制码不执行。纯文本一次 LinkDetector 后按文本偏移着色，颜色切换不切断 URL；过滤/无障碍去转义，Rust 原始日志不变。                                                           |
| `browser/debugChatIntegration.ts`               | 本次补齐 | Chat Add Context registry → 当前暂停帧和 scope/变量快照 → Chat 自有附件。仅用户选择后附加，不发送消息；继续执行后不接受迟到检查，已选择附件保持不可变快照。                                                                                                               |
| `browser/debugColors.ts`                        | 已有承接 | 启动复合控件通过 `debugActionViewItems.ts` 使用 `debugIcon.startForeground`，由 `debugColors.ts` 注册四种主题的启动图标颜色。其余 Debug 样式使用已有 foreground/error/accent/focus/selection token，ANSI 使用 `terminal/common/terminalColorRegistry.ts` 的注册色。       |
| `browser/debugConsoleQuickAccess.ts`            | 本次补齐 | `workbench.action.debug.selectDebugConsole`/`debug consoles ` → DI provider → 现有 `replModel.sessions/selectSession` → Console view；包括保留的已结束控制台，菜单不再造会话状态。                                                                                        |
| `browser/debugEditorContribution.ts`            | 本次补齐 | 真实 editor contribution 注册 → 当前帧/模型 → scope hover 与可关闭行内值；模型变化、恢复、换帧及释放均撤销旧投影。                                                                                                                                                        |
| `browser/debugExpressionRenderer.ts`            | 已有承接 | `variablesView.ts` 的 DebugVariableItem、`watchExpressionsView.ts` 的 watchItem 与 `replViewer.ts` 各自输出 textContent、类型和 managed hover；没有上游 Expression 对象、visualizer 命令或共享 template 数据端口。不复制其 renderer 类图；富值着色/可视化不在当前端口内。 |
| `browser/debugHover.ts`                         | 本次补齐 | 读取当前暂停 scope 及属性路径，复用共享 editor hover。悬浮不执行源码表达式，不建立另一份变量状态。                                                                                                                                                                        |
| `browser/debugMemory.ts`                        | 本次补齐 | Variables/F1 → 有 inspectionRevision 的 debug-memory 文件 → Rust readMemory/writeMemory。原始字节与十六进制文本编解码分开；保留字节数、条件写入，旧暂停代次拒绝读写。真实 Desktop 已验证保存。                                                                            |
| `browser/debugProgress.ts`                      | 本次补齐 | typed DAP progress start/update/end → 共享 ProgressService 通知；取消走 session.cancelProgress，结束/会话释放结算显示，数量有界。                                                                                                                                         |
| `browser/debugQuickAccess.ts`                   | 本次补齐 | Quick Open 的 `debug ` → provider → 当前 ConfigurationManager → DebugService.start/startCompound；多目录身份保留，异步目录替换/查询取消不发布旧项，动态配置继续走现有 Select and Start owner。                                                                            |
| `browser/debugSessionPicker.ts`                 | 已有承接 | `debugToolBar.ts` 的 Active debug session select 和 `repl.ts` 的 Console select 已调用唯一 setActiveSession/selectSession；键盘可用。当前没有上游独立 transient session menu 的命令调用方，不再增加转发菜单。                                                             |
| `browser/debugSettingMigration.ts`              | 不适用   | 历史输入格式差异：此文件只迁移 VS Code 的 debug.autoExpandLazyVariables 布尔旧值。Ash 自有设置源没有 VS Code 配置导入；实际 v1/v2 Debug 工作区数据由 debugStorage.ts → Rust workspace migration 处理。仅排除该历史格式转换。                                              |
| `browser/debugStatus.ts`                        | 已有承接 | `debugToolBar.ts` 的 role=status 展示当前会话/暂停原因/操作错误；`debugTitle.ts` 在失焦窗口标记暂停。Ash 选择内联状态，没有上游 statusbar 调试启动按钮消费者；不再创建第二份选择/状态。                                                                                   |
| `browser/exceptionWidget.ts`                    | 本次补齐 | 暂停异常 + 当前源码 → session.exceptionInfo → editor content widget；继承编辑器坐标，Escape/关闭返回编辑器，继续/换帧清除；Help/View/verbosity 已注册。                                                                                                                   |
| `browser/extensionHostDebugService.ts`          | 不适用   | 已确认的 SDK 架构差异：docs/editor-extensions.md 规定 @ash/sdk，开发宿主沿 ExtensionHostSupervisor/Host RPC；不采用 VS Code Extension Development Window 的 broadcast/debug IPC。DAP 适配器和 Ash 扩展命令仍走真实 Debug/SDK 服务。                                       |
| `browser/loadedScriptsView.ts`                  | 本次补齐 | 独立注册的 Loaded Scripts 视图 → typed loadedSources/catalog 事件 → 筛选、键盘打开本地/远端/引用源码；隐藏时停止查询，迟到结果不覆盖新会话。                                                                                                                              |
| `browser/media/breakpointWidget.css`            | 已有承接 | 条件/日志编辑表单的 DOM 是 BreakpointsView，已有 `media/debugViewlet.css` 的 `.ash-debug-breakpoint-edit` 样式和浏览器验证；不存在上游 ZoneWidget DOM，不挪入错误样式 owner。                                                                                             |
| `browser/media/callStackEditorContribution.css` | 本次补齐 | 新 contribution 直接导入；仅命中 `.ash-debug-stack-frame`/gutter，借用选择/对比度/强调主题 token，保留独立断点 gutter lane。                                                                                                                                              |
| `browser/media/callStackWidget.css`             | 不适用   | 同一 Testing 内嵌 widget 的样式职责；Debug Call Stack pane 的 Ash DOM 由 debugViewlet.css 拥有。不能用此项排除 Debug 的堆栈选择和源码跳转。                                                                                                                               |
| `browser/media/continue-tb.png`                 | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/debugHover.css`                  | 已有承接 | 新增 Debug scope provider 使用 editor/contrib/hover 的同一 hover DOM、键盘/无障碍和样式 owner；行内值样式归已有 debug.contribution.css。无第二套 Debug hover DOM，故不创建重复 stylesheet。                                                                               |
| `browser/media/exceptionWidget.css`             | 本次补齐 | 仅命中 Ash ExceptionWidget，使用 editor.hover*、focusBorder、contrastBorder 和字体 token；不复制上游 ZoneWidget CSS。                                                                                                                                                     |
| `browser/media/pause-tb.png`                    | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/restart-tb.png`                  | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/run-with-debugging-tb.png`       | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/stepinto-tb.png`                 | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/stepout-tb.png`                  | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/stepover-tb.png`                 | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/media/stop-tb.png`                     | 已有承接 | DebugToolBar/ActionViewItems 已使用注册的 Lxicon 语义图标和主题 token 承接对应操作，四主题/键盘路径沿同一按钮；不保留另一套工具栏位图资源。                                                                                                                               |
| `browser/runAndDebugAccessibilityHelp.ts`       | 本次补齐 | Debug 注册 help provider，按容器实际焦点准入；使用独立 verbosity 设置、当前 pane/键盘说明、中文与真实 AccessibleViewService，关闭后返回原控件。                                                                                                                           |
| `browser/statusbarColorProvider.ts`             | 本次补齐 | 活动调试会话 → IStatusbarService.overrideStyle 租约 → StatusbarPart；noDebug 不染色，最后会话结束恢复原 owner；四种主题已验证。                                                                                                                                           |
| `common/abstractDebugAdapter.ts`                | 已有承接 | `browser/rawDebugSession.ts` → platform/debug capability → `crates/debug-client` 请求配对/超时及 `crates/debug-adapter` transport；inline/tracker 共用 Rust client。不恢复第二套 TS adapter pending table。                                                               |
| `common/breakpoints.ts`                         | 本次补齐 | 校验扩展 contributes.breakpoints 的 language/when，F9 和 gutter 共用策略；debug.allowBreakpointsEverywhere 显式保留 Ash 原有默认行为，关闭后强制声明条件。运行时断点仍只有 DebugService owner。                                                                           |
| `common/debugAccessibilityAnnouncer.ts`         | 本次补齐 | 当前 Watch 请求代次成功结果 → 可选 accessibility.debugWatchVariableAnnouncements → 现有 AccessibilityService；值变化去重、会话切换重置，不播报失败/迟到结果。                                                                                                             |
| `common/debugCompoundRoot.ts`                   | 已有承接 | `DebugService.startCompound` 校验目录/配置并持有 member listeners；Rust `debug-manager/src/sessions.rs` 管理 parent/managed lifetime。stopAll 随成员退场释放，不再生成第二个 compound 状态 owner。                                                                        |
| `common/debugContext.ts`                        | 已有承接 | VariablesView 的当前 row/inspection generation 判断赋值、只读、数据断点及 memory 能力；可视化和 Chat 从同一暂停身份捕获快照，命令边界校验参数。菜单条件继续使用共享 ContextKeyService，不建立第二份变量 context 状态。                                                    |
| `common/debugLifecycle.ts`                      | 本次补齐 | debug.confirmOnExit → 生命周期 beforeShutdown veto → 共享 DialogService；用户同意后沿既有 owner 清理，取消则保持窗口和调试会话。                                                                                                                                          |
| `common/debugModel.ts`                          | 已有承接 | `crates/debug-manager` 的 lifecycle/inspection/breakpoints/sessions/workspace 拥有执行与持久状态；`DebugSession` 只适配只读快照，`debugViewModel.ts` 只拥有窗口选择，`replModel.ts` 只拥有展示缓存。禁止再建可变 TS DebugModel。                                          |
| `common/debugProtocol.d.ts`                     | 已有承接 | `crates/debug-contract`、platform/debug 的领域契约与 runtime adapter 承接已开放请求；网络 JSON 在 Rust client/TS adapter 边界校验。不复制完整 DebugProtocol namespace 或让 UI 依赖生成 DTO。                                                                              |
| `common/debugSchemas.ts`                        | 已有承接 | `debugConfigurationManager.ts` 校验 launch/compound 输入，`services/extensions/common/extensionManifest.ts` 校验 debugger 声明。Ash SDK 接纳子集，不注册 VS Code extension points；上游全量 JSON schema/补全不是当前声明契约。                                            |
| `common/debugTelemetry.ts`                      | 不适用   | 明确产品取舍：docs/editor-extensions.md 规定产品不采集或上传遥测，composition 选择 NullTelemetryService（TelemetryLevel.NONE）。故不恢复 Debug usage/session/breakpoint 采集；调试错误仍交 ILogService。                                                                  |
| `common/debugVisualizers.ts`                    | 本次补齐 | Visualize Variable → 有界变量树或 Ash contributes.debugVisualizers + 既有 SDK command → 只读编辑器。检查代次/扩展目录变化拒绝旧结果；自有扩展命令契约不恢复 VS Code Extension Host。                                                                                      |
| `common/loadedScriptsPicker.ts`                 | 本次补齐 | Debug: Open Loaded Script → 所有支持 loadedSources 的会话 → canonical source URI → 原编辑器/source provider；取消、工作区切换、会话结束撤销选择。                                                                                                                         |
| `common/nullDebugService.ts`                    | 不适用   | DI/能力装配架构差异：支持 Debug 的 Code/Sessions 显式构造真实服务；其他产品不装配该 capability。必需依赖缺失应报错，不以 null 服务吞掉缺注册；测试替身不作为生产实现。                                                                                                    |
| `common/replAccessibilityAnnouncer.ts`          | 已有承接 | `Repl` 已有 role=log 的输出容器、AsyncDataTree 逐行 aria-label、ReplAccessibleView 过滤纯文本。上游额外 announcer 的通知模式没有注册，不重复播报同一条输出；ANSI-free 文本本次同步修正。                                                                                  |
| `electron-browser/extensionHostDebugService.ts` | 不适用   | 同一 VS Code 专属 Extension Development Host IPC 的 Electron relay；Ash SDK 宿主监管/开发入口见 docs/editor-extensions.md 与 sdk/docs/development.md，不打包此产品宿主通道。                                                                                              |
| `node/debugAdapter.ts`                          | 已有承接 | `crates/debug-adapter/src/service.rs` 已拥有 stdio/TCP/named-pipe 启停，framing.rs 拥有有界 DAP framing；RawDebugSession 调用同一平台 capability，Renderer 不执行 Node 子进程。                                                                                           |
| `node/telemetryApp.ts`                          | 不适用   | 同一“不采集或上传产品遥测”的明确政策；不启动上游 telemetryAppender 专用进程。依据同上，不以日志冒充遥测。                                                                                                                                                                 |
| `node/terminals.ts`                             | 已有承接 | `DebugService` 的 runInTerminal → ITerminalService/TerminalProfileResolver/TerminalProcessService → 选定本地/远端 Terminal owner，cwd/env 授权和请求取消沿原 owner；不新增 Node shell/进程生命周期。                                                                      |

唯一 Ash 生产路径 `browser/media/disassemblyView.css` 保留在已存在的 DisassemblyView DOM owner；用户已允许按职责迁移，上游没有同 DOM 的 stylesheet，机械改名不能形成正确对应，本次没有删除文件。

`linkDetector.ts` 仅公开当前 REPL 使用的 linkify 端口；高亮范围、adapter location-reference、home expansion 和带空格引号路径没有未使用的 API 外壳。`debugTaskRunner.ts` 使用现有字符串 Task id/label 和 readiness/completion；任务执行归 TaskService，启动成功策略归 DebugService。结构化 task id、runTaskAndCheckErrors 和 debugUtils 的未使用成员不制造虚假调用方。

### Validation

- Debug units: 230 tests across 11 files passed, including service-owned frame
  selection without a view, late-selection retirement, frame-scoped command reveal,
  hidden welcome cancellation and assignment-driven Watch refresh.
- Browser Debug and view-pane layout: 49 tests passed. Six affected interaction
  scenarios were rerun after review, covering hidden-view editors, draft/focus
  restoration, keyboard resizing, status layout and notification feedback.
- Ash Desktop: save-before-launch, background-build readiness, full real DAP
  inspection/edit/step/stop and isolated SSH Desktop inspection passed (4 tests).
  Empty-window welcome also passed. Rust test debugging failed before reaching the
  migrated view caller: the adapter returned `invalid DAP Content-Length`; its
  post-launch assertions remain unverified. Evidence: `/tmp/ash-debug-turn3-desktop-callers.log`.
- The broader Desktop selection also attempted unrelated debugger retirement;
  it failed in the extension-management native dialog before opening Debug. That
  scenario is not covered by the four passing Debug results. Original evidence:
  `/tmp/ash-debug-turn3-desktop.log`.
- Renderer typecheck (4,454 files), targeted CSS lint (5 stylesheets), TypeScript
  formatting (20 files) and localization (zh-CN, no missing entries) passed. Final
  source/source-navigation and form reviews also passed 115 focused service/view
  units and 4 browser breakpoint scenarios. No interactive upstream parity run was
  made; UI results establish Ash regression coverage, not complete equivalence.

### Visibility and source-navigation follow-up

The follow-up changes existing production paths only: the generic view model and
its descriptor-service DI assembly, DebugService's frame contract and dependency
registration, Call Stack's selection caller and Disassembly's implicit selection.
The test-only view descriptor bootstrap supplies real profile storage to existing
unit fixtures; production dependency resolution has no optional storage fallback.
No production file was added or deleted for this slice.

- Debug and affected framework/consumer units: 515 tests across 22 files passed,
  including the updated terminal-launch dependency fixture. Service tests cover
  default local, Remote and adapter-owned source navigation without Call Stack,
  plus late virtual-source replies after continue, explicit selection,
  session/workspace replacement and disposal. Framework tests use real profile
  storage for reload, workspace changes, profile isolation, external changes,
  malformed state, late view registration, non-toggleable views, required
  constructor dependencies and reentrant changes. Evidence:
  `/tmp/ash-debug-turn4-unit-green.log`.
- Debug and auxiliary-bar browser checks: 38 passed. Generic view-pane layout:
  15 passed, including non-default language and high-contrast scenarios. Evidence:
  `/tmp/ash-debug-turn4-browser-debug.log` and
  `/tmp/ash-debug-turn4-browser-layout.log`.
- The new real Ash Desktop scenario passed: hide Call Stack through the native
  menu, reload before it is created, pause and step to the source editor's exact
  line, then reveal the pane and reload again. The existing full DAP inspection
  and SSH Debug scenarios also passed during this follow-up. Evidence:
  `/tmp/ash-debug-turn4-desktop-native.log` and
  `/tmp/ash-debug-turn4-desktop.log`.
- Expanded composite-browser checks: all 47 passed after completing fixture
  configuration/hover dependencies, admitting editor features through the product
  entry and checking the shared 20px-high, content-width keycap contract. Trace
  links are opened through actual pointer/modifier interaction in en/zh-CN.
  Evidence: `/tmp/ash-composite-fix-green.log`.
- Output shutdown regression: 70 Output/view/default-log-level unit tests passed.
  Bulk Output disposal no longer publishes registry/selection changes, and default
  log-level subscriptions retire after confirmed shutdown before producer teardown;
  a veto keeps them live. The real Ash Desktop Agent Output/Trace flow, including
  closing and reopening its window, passed. Evidence:
  `/tmp/ash-composite-fix-units-final.log` and
  `/tmp/ash-composite-fix-desktop-lifecycle.log`.
- Renderer typecheck: 4,455 files passed. TypeScript formatting passed for the
  changed paths. Localization: zh-CN has no missing entries. No interactive
  upstream parity run was made.

### Console text-link contracts

These 20 contracts cover the production chain
`Repl → ReplOutputElementRenderer → LinkDetector → Opener/FileService/EditorService`.
They count responsibilities and observable behavior, not 20 new files. The one new
production counterpart is `browser/linkDetector.ts`; no file was removed.

| #   | Contract                   | Owner and observable result                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Canonical entry            | The REPL renderer constructs LinkDetector through the window DI scope and uses its `linkify` port.                 |
| 2   | Literal output             | Plain/HTML-looking output, unsupported schemes and oversized candidates remain text.                               |
| 3   | Web navigation             | HTTP and HTTPS targets use OpenerService with a user gesture.                                                      |
| 4   | Mail navigation            | Mail links use the same external-opener owner.                                                                     |
| 5   | Link boundaries            | Multiple links retain surrounding punctuation and balanced parentheses.                                            |
| 6   | Multiline output           | Line splitting preserves empty lines and the final newline.                                                        |
| 7   | POSIX files                | Absolute source paths resolve beneath the captured execution authority.                                            |
| 8   | Windows spelling           | Drive paths normalize separators without turning the drive into a URI scheme.                                      |
| 9   | Relative files             | Dot-relative and subdirectory paths resolve against the originating folder.                                        |
| 10  | File URIs                  | Explicit file URIs preserve escaped filenames.                                                                     |
| 11  | Source selection           | Positive line/column suffixes become EditorService selections.                                                     |
| 12  | Remote files               | Absolute, relative and file-URI paths retain the Remote folder authority.                                          |
| 13  | Resource admission         | Missing files, directories, invalid locations and bare paths without a folder stay plain.                          |
| 14  | Producer identity          | Shared-console chunks from different sessions are not joined; retained rows keep their captured context.           |
| 15  | Chunk projection           | Same-session fragments form one link; filtering still uses original immutable entries.                             |
| 16  | Pointer activation         | Modifier clicks open links; ordinary clicks and text selection do not.                                             |
| 17  | Keyboard navigation        | Tab reaches links, Enter activates them and Shift opens files in a side group.                                     |
| 18  | Row and workspace lifetime | Row listeners/hovers are released, and late file checks cannot activate retired rows/workspaces.                   |
| 19  | Failure feedback           | Opening errors use the notification service only while their row is current.                                       |
| 20  | Accessible themed output   | Text stays readable in Accessible View; help, link descriptions, focus and colors cover zh-CN and all four themes. |

Validation: 260 Debug units across 12 files passed. Debug/view-pane browser
regression passed 52 tests, followed by the three link scenarios with final color,
Tab and non-default-language assertions. Real Ash Desktop passed local text-file
navigation/clear after stop, SSH text-file navigation and structured Rust output;
the latter's error assertion now follows the existing notification owner.
Windows path spelling is tested at the filesystem boundary on this POSIX host;
no native Windows run or interactive upstream parity run was made.

Evidence: `/tmp/ash-debug-links-unit-green.log`,
`/tmp/ash-debug-links-browser-green.log`,
`/tmp/ash-debug-links-browser-links-final.log`,
`/tmp/ash-debug-links-desktop.log` (two passing navigation scenarios) and
`/tmp/ash-debug-links-desktop-structured.log` (structured-output rerun).
Renderer typecheck, targeted CSS lint, TypeScript formatting and localization
checks also passed.

### Corrected review implementation and validation (2026-10-21)

The exact pre-edit tree and scoped admissions were saved before implementation in
`/tmp/ash-debug-recheck-baseline.json` and its companion diff. Newly admitted paths
have upstream counterparts; existing files changed only at their consumer, contract,
registration, tests or localized text hunks. No file was deleted in this review.

The production chains are editor → current ViewModel/frame → Rust inspection →
shared hover, inline values and exception widget; Variables/F1 → epoch-bound memory
resource → FileService hex codec → typed Rust memory requests; source catalog →
independent view/Quick Input → canonical source provider; adapter progress → shared
ProgressService; Watch → optional accessibility announcer; shutdown → lifecycle veto.
Chat receives explicitly selected immutable Debug snapshots through its common
context registry. Visualizers use bounded variable traversal or validated Ash
manifest declarations and the existing authorized SDK command path. Status color is
a scoped style lease; StatusbarPart never imports Debug. Breakpoint language/when
policy is shared by the gutter and F9; runtime breakpoint ownership is unchanged.

Final validation: The prior “30 not
applicable” conclusion and its absence-of-caller arguments are superseded by the
corrected table. Windows and physical assistive technology remain outside this
macOS validation scope. The paired Desktop interaction run is now complete for the
explicit matrix below; this is behavioral evidence for those scenes, not a claim
of complete VS Code product parity.

Final regression admission: Debug Console's wide header filter → existing
FilterViewPane → existing browser/parts/views/media/views.css (shared upstream
owner). Browser DOM/computed-style evidence showed the generic hidden-action rule
winning over the filter's rule after the main update. Only the owned selector gains
pane/expanded specificity; filter DOM, layout and action visibility remain with the
shared component. The existing zh-CN Console test is the failing/repair scenario.

The same expanded regression found the composite integration host omitted the now
required IConfigurationService before constructing a real view container. Its test
composition now registers the real configuration service fixture; production DI
remains mandatory. Exact additional path: test/integration/browser/composite.integration.ts,
one import and one registration, preserving its existing unrelated changes.

- `pnpm test:unit --runGlob '**/contrib/debug/test/**/*.test.js'`: **278 passed**
  across 18 files. Covers scoped hover cancellation, shutdown veto, Watch speech,
  memory raw/text codec, conditional writes, invalidation/watch disposal, adapter
  progress cancellation and presentation lifetime, Chat snapshots, visualizer input
  and output validation, language/when policy and the prior Debug behavior.
- Statusbar service/Part units: **18 passed** across two files, including style
  priority/release. Renderer typecheck: **4,481 files, zero errors**; strict generated
  protocol compile: **1,691 files, zero errors**. The Debug test compilation passed.
- `pnpm test:browser:integration debug.integration.spec.ts viewpaneLayout.integration.spec.ts --project=chromium --max-failures=1`:
  **64 passed**. Includes scoped editor values and their retirement, localized
  exception Help/focus return, Loaded Scripts keyboard opening, visualization/Chat
  snapshots, status colors in four themes and shared header-filter/layout coverage.
- `pnpm run smoketest test/smoke/areas/debug/debug.spec.ts --grep 'Debug memory, loaded scripts and exception details|installed Ash command visualizer'`:
  **2 real Ash Desktop scenarios passed**, after rebuilding the backend and product.
  One reads/edits/saves actual DAP memory bytes, shows exception info and opens a
  sourceReference script. The other installs/enables/authorizes an Ash package,
  invokes its SDK command visualizer with the paused variable and renders read-only
  output. Earlier native installation selectors were corrected to the current UI.
- `just verify ash-debug-manager`: **53 tests passed** plus check/warnings;
  `just verify ash-app-server-protocol` and `just verify ash-app-server` passed
  check/tests/warnings. Protocols were regenerated through the owning recipe.
- CSS lint: **8 stylesheets, zero errors**; zh-CN: **zero missing entries**;
  targeted TypeScript formatting and `git diff --check` passed. Inventory is now
  **61 shared / 33 upstream-only / 1 approved Ash-only**. All original 53 paths
  match the table exactly. Six shared stylesheets differ from upstream even after
  prefix normalization; no `monaco-*`/`--vscode-*` CSS was introduced.

Evidence: `/tmp/ash-debug-recheck-{debug-units-final,browser-final,desktop-final,rust-manager-final,server-final,protocol-tests,localization-final,css-final}.log`.
The follow-up configuration owner review resolved the extension-service failure:
withdrawing a schema removes its defaults and registration, while user-persisted
values remain readable and unchanged on disk. Reactivation restores the extension
schema/defaults and continues to use the saved user value. The extension-service
suite (**49 passed**) and canonical configuration owner suite (**3 passed**) now
pass together. Evidence: `/tmp/ash-debug-pair-configuration.log`. The correction is
in the integration assertion; production configuration semantics are unchanged.

### Paired Desktop interaction acceptance (2026-10-21)

The source reference remains the read-only checkout at `924c808fbab`. The running
reference is the installed **VS Code 1.143.0**, commit
`2d0b7506a36c1d6db9a466440131a8e01eab2289` (2026-10-20); it is not a build of that
checkout. Ash was rebuilt from this checkout at `3a0b45820013641c8f555aaa77714667cca282a4` with its existing
uncommitted Debug work. The scoped starting tree is preserved in
`/tmp/ash-debug-pair-baseline.json` and its companion diff. The additional
Variables slice has its own pre-edit tree in
`/tmp/ash-debug-pair-expansion-baseline.json`.

`test/smoke/areas/debug/debug-paired.spec.ts` runs both Desktop products against
one independently authored stdio DAP peer and the same synthetic 200-line source.
Ash uses its real App Server/Rust Debug owner; the reference uses a disposable
extension that only registers a standard executable adapter. User actions go
through the actual views, command palettes, editors and keyboard handlers.

| Semantic scene                     | Assertions in both products                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent Call Stack visibility  | Hide through the views menu, reload, launch with the pane absent; the stopped source still opens at line 2.                                                                                   |
| Variable inspection and assignment | Cancel `100` without sending an assignment; commit `answer = 43` and nested `child = 2`; recorded DAP addresses are parent containers 10 and 20.                                              |
| Watch and stepping                 | Watch reads 43, then changes to 44 after Step Over; source selection follows line 3, Call Stack remains absent, and the object/child expansion stays open.                                    |
| Source input and scrolling         | Select three characters; navigate to line 200, observe it in the rendered viewport, then return to line 1 with editor focus. macOS reference bindings are Cmd+Down/Up; Ash uses Cmd+End/Home. |
| Debug Console                      | Type `answer`, submit with Enter, observe 44; the peer receives `evaluate` with `context: repl`, and input retains focus.                                                                     |
| Themes and layout                  | Apply dark, light, high-contrast dark/light themes; assert actual theme state, variable focus, nonzero in-viewport geometry at 1000×700, and computed status bar foreground/background.       |
| Loaded source                      | Filter and open `paired-generated.js`; `sourceReference: 25` reaches the peer and its generated content appears in the real editor.                                                           |
| Session retirement                 | Stop through the command palette; exactly one disconnect reaches each peer and the variable presentation clears.                                                                              |

The eight normalized behavior results match. Four theme states and the variable
cancel focus state are recorded separately: **13 captures per product, 26 total**.
After Escape, Ash restores the variable button's focus; this reference build leaves
focus on the document body. The difference is retained in the evidence rather
than weakened to a claimed focus match. Ash keeps its own palette and pane
allocation; the assertions compare usable state and bounds, not pixel identity.

The paired review exposed an Ash regression: stepping cleared the Variables
object expansion. `variablesView.ts` now retains only expansion paths per live
session/frame (the most recent 32 frames), then reloads children using the new
inspection's references. Explicitly collapsed nodes stay collapsed; late replies
are rejected by the existing inspection generation. The new owner test reproduces
the old failure and covers reference 21 → 31, a changed child value, explicit
collapse, and a late restoration reply after resume. **All 279 Debug units across
18 files passed**, including 18 view-owner tests. No parallel Debug data owner,
new public API, DOM or stylesheet was introduced.

The paired test passed after rebuilding Ash with that repair. It asserts object
expansion after stepping and changes the peer's value on step so the Watch
assertion cannot pass with a stale result. The external process is registered with
the existing smoke runner for interruption cleanup and closed in `finally` even
if evidence collection fails. No UI state is injected into either Debug owner.

Reproduce on this machine after the normal smoke preparation:

```sh
ASH_DEBUG_UPSTREAM_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
  pnpm run smoketest-no-compile test/smoke/areas/debug/debug-paired.spec.ts
```

The test deliberately requires an explicit reference executable and otherwise
skips. The successful run is preserved at `.build/debug-pair/acceptance/`:
`paired-debug.json` contains results/focus/geometry/colors; both `*-requests.jsonl`
files contain actual adapter traffic; 26 step PNGs and `reference-trace.zip`
provide review evidence. `provenance.json` records host/source revisions and
artifact sizes/SHA-256 hashes. Final log:
`/tmp/ash-debug-pair-acceptance-expansion-final.log`. Renderer and automation typechecks and scoped
formatter checks also passed. The paired acceptance and configuration review have
been removed from root TODO.

### Desktop acceptance closure (2026-10-21)

The two remaining Desktop scenarios now pass after rebuilding the backend and
Ash from this checkout. The Rust case runs an actual Cargo test binary through
the bundled `debug-lldb` provider and its verified CodeLLDB 1.12.3 runtime. It
executes macro and documentation tests, toggles F9, stops in `checks::passes`,
checks a verified gutter breakpoint and the real stack, removes the breakpoint,
continues to termination, clears frames and re-enables Testing execution.

Testing previously bypassed providers and forced the system `lldb-dap`. This
turn reproduced `Debug adapter exited`; the matching macOS crash report shows
Apple LLDB failing in Mach-O symbol parsing. The same tool crashes while loading
`/bin/echo`, independently of Ash. This does not prove the bytes behind the earlier
`invalid DAP Content-Length` report. The fix removes system-adapter selection
from Testing's model, runner and generated protocol; Workbench requests `lldb`
through the existing provider and its runtime settings. DAP framing stays strict.
The system toolchain itself has not been repaired or claimed as passing.

The extension-withdrawal case now uses the actual Extensions search/details
flow. Enable/Disable are direct actions; Grant/Revoke permissions and Uninstall
retain their real confirmation dialogs. After disabling the unrelated debugger,
the pending background build is released, its original Debug launch reaches a
stopped session, Stop succeeds, and task termination reaps the compiler process.
Revocation and uninstall then complete. The test returns to Run and Debug before
querying its controls, and the Rust case uses the independent Breakpoints view's
accessible Remove breakpoint action.

Validation: **2 Desktop scenarios passed**, **8 TestingService units passed**,
`just verify ash-testing` passed (**7 tests**, check and warnings), and
`just verify ash-app-server-protocol` passed (**159 units + 3 boundary + 1 schema
hash tests**, check and warnings). Protocol generation, strict generated-contract
checking, the Desktop build and automation typechecking passed.
`just verify ash-app-server-runtime` also passed: **1,010 tests passed,
12 ignored**, with check and warnings passing. The final smoke log is
`.build/debug-desktop-acceptance/desktop-final.log`; the evidence directory
also retains reproduction and build logs. No system debugging permissions were
changed; no test-owned adapter/debugserver processes remained after teardown.
These two entries have been removed from root TODO. Architecture recommendations
for automatic attachment and server readiness are in
[`docs/debugging.md`](../../../../../docs/debugging.md#javascript-调试自动附加与服务就绪).

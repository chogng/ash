# Workbench Debug

The system-level ownership and current user-visible status are documented in [`docs/debugging.md`](../../../../../docs/debugging.md). This README owns the Renderer implementation contract.

## Current ownership and execution path

This section describes the running Workbench implementation. Rust request ownership is already connected through `browser/rawDebugSession.ts`; the full manager migration and VS Code frontend alignment remain defined in [the system design](../../../../../docs/debugging.md#已确认的目标分层).

`common/debug.ts` is the canonical frontend contract. `browser/debugService.ts` implements `DebugService` and owns launch/compound configuration, source, function, data, and instruction breakpoints and workspace-persisted Watch expressions, exception-breakpoint selection, task orchestration, the active session, and the collection of concurrent sessions. `DebugSession` owns the Workbench facade, runtime-intent submission, read-only binding snapshots, thread/frame selection, URI/result conversion, output and host reverse-request callbacks. Rust owns initialization, normalized and incremental capabilities, execution state, initial exception-breakpoint configuration and in-flight inspection invalidation. Rust now also owns admitted runtime intents, source/family replacement order, DAP bindings/events and stack/frame/variables/Watch job orchestration. The editable workspace catalogue, exception selection and its Memento persistence still await durable migration. `common/debug.ts` also declares the REPL model contract; `DebugService` owns one `common/replModel.ts` model that subscribes before any UI is visible, retains bounded per-session DAP/REPL output, and keeps terminated sessions inspectable. The same contribution implementation validates `runInTerminal` and delegates presentation to `ITerminalService`. Its stable dependencies use constructor DI; the window registers its selected DAP process capability, including explicit unavailability. `IAdapterManager` is the shared registration contract; the injected `browser/debugAdapterManager.ts` implementation owns factories for the window and is shared by declarative packages, the Extension Host and Debug. Generic services import only the common contract.

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

`DebugBreakpointDecorationProvider` is the only Debug-to-editor adapter. The editor owns a generic composable gutter contract and must not import Debug semantics. `DebugSession` also converts adapter source paths into URIs on the current local or Remote Workspace authority; `DebugViewPane` consumes that domain resource and never reinterprets a Remote path as local `file://`. Process lifetime, bounded DAP framing, trust retirement, and connection ownership remain backend responsibilities.

Console output is retained synchronously. Output-only change notifications are coalesced
over 16 ms so a DAP burst does not rebuild the console for each message. Session changes
and clearing publish immediately and cancel the pending output notification; disposal
cancels it as well. Keyboard input, focus and output order remain independent of batching.

## Configuration and extension integration

`startDebugging` also accepts a caller-supplied configuration, used by TestingService for an exact compiled test. It does not write `launch.json`; restart retains that configuration. F9 invokes `editor.debug.action.toggleBreakpoint` through the current editor and the same breakpoint owner. LLDB-DAP zero-sequence responses and events retain their adapter identity; request pairing uses `request_seq`, independently of the backend output cursor. Stack frames retain DAP zero line/column values for unavailable positions; inspecting them does not invent a source location. A view opened after a session has stopped immediately reads the existing session.

Each `.vscode/launch.json` configuration can declare an explicit `debugAdapter.program` plus `debugAdapter.args`, or a `debugAdapter.connection` server/pipe endpoint. `debugServer` takes precedence over both explicit descriptors and extension factories and connects to the given local TCP port. If it omits `debugAdapter`, `parseLaunchConfigurationDocument` retains dormant types without invoking providers and resolves already registered defaults through the canonical `IAdapterManager`. Declarative extensions register one caller-owned factory set for the program/argument descriptors contributed through `contributes.debuggers`; other runtime producers use independent registrations. Dynamic factories run after the pre-launch task succeeds or its background matcher reports readiness, so they can inspect the build's adapter artifact. A failed build or error diagnostics prevent both descriptor invocation and adapter startup.

All remaining configuration properties are forwarded to the adapter after `Debugger.substituteVariables` resolves `${env:NAME}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${command:...}`, and `${input:...}` through the shared `IConfigurationResolverService.resolveWithInteractionReplace`. Named folder selectors such as `${workspaceFolder:server}` use the current Workspace folder names. Resolution fails before task or adapter execution when a referenced folder is unavailable. The source configuration remains unchanged for restart; the executable, adapter arguments, launch arguments, and pre/post task references are resolved into a separate execution snapshot. A command or configured input variable is evaluated once per invocation and reevaluated when a new session starts. Inputs come from the selected folder’s `.vscode/launch.json` through FileService; launch arguments do not include the document’s input definitions. `promptString` and `pickString` reuse Quick Input; command inputs execute their declared command with `args`. Cancellation by Escape, workspace change, or resolver disposal closes the owned prompt and prevents startup. Cancellation prevents both pre-launch tasks and adapter creation; invalid resolved executables fail before either side effect. The value comes from the current Workspace URI: native filesystem syntax for `file:` and decoded POSIX syntax for Remote. Workbench-only `preLaunchTask` and `postDebugTask` fields are removed before the DAP launch/attach request. Compounds resolve configuration IDs, unique names, or `{ name, folder }` references and may request `stopAll` behavior. Every reference is validated before the compound pre-launch task runs.

`DebugAdapterFactoryRegistry` accepts static executables and asynchronous `createDebugAdapterDescriptor` callbacks. Dynamic types remain discoverable without calling a provider or allocating a process. At dispatch, DebugService resolves configuration variables, then the Host-broker provider receives `{ configuration: { name, type, request, ...arguments }, session: { id, workspaceFolder }, dirId? }` and returns `{ program, arguments }`. MainThreadExtensionApi binds the callback to its admitted registration, activation generation and incarnation; replacement or disconnect revokes it. DebugService cancels all pending callbacks on workspace change or disposal. Removing a provider or factory cancels only callbacks bound to that registration; unrelated launches and configuration discovery retain their lifetime. A selected factory is checked again after the pre-launch task and before descriptor invocation, so a retired factory cannot start an adapter. Invalid descriptors prevent adapter startup. Descriptor callbacks run after the pre-launch task, so their result cannot prevent a build that has already completed. Restart resolves the descriptor again. The existing Rust DAP transport owner starts the resulting executable or connects to the returned server/pipe endpoint. The standard `DebugAdapterServer` and `DebugAdapterNamedPipeServer` classes map to this same path; connected descriptors keep executable fields absent. The Host RPC and standard facade share session handles and tracker delivery. Inline descriptors create an opaque SDK handle and bind finite send/read/close callbacks to the same prepared session. The session owns that IO before tracker startup and releases it on startup failure or cancellation; a late descriptor from a retired creation lifetime is closed. Remaining session options still require implementation.

The shared configuration resolver exposes non-interactive `resolveAsync` and interaction-capable `resolveWithInteractionReplace`. Command aliases use the resolver port, and commands receive the configuration after workspace-folder substitution. Root `windows`, `osx` and `linux` overrides select the execution host before references are collected; platform blocks are removed from the resolved copy, while the original remains available to providers and restart. Object keys and nested replacement values are resolved from the expression's invocation-local cache. Environment lookup batches current unresolved names on the authorized execution host; nested values can introduce another batch. Missing names become empty strings. Raw shell syntax remains data. Pending reads cancel on workspace change or disposal before command variables can execute. Configuration-target selection beyond folder files, contributed variables remain unimplemented; other placeholders remain unchanged. Web and Electron use the same typed backend query. Inherited values retain the backend environment allowlist policy.

## Durability and failure semantics

DebugService validates and normalizes its persisted schema, updates the workspace object returned by `Memento.getMemento`, and calls `saveMemento` on the Storage save lifecycle. Memento owns scoped JSON storage and explicit reload; DebugService owns external-change handling and preserves pending local edits. It stores source and function breakpoints, data breakpoints explicitly marked `canPersist` by the adapter, Watch expressions, and per-adapter-type exception filters in workspace scope. Version 1 source-only state migrates to version 2. Durable points retain enabled state and conditions; source and function points retain log messages, and source points retain public IDs and columns. Data points retain their opaque `dataId`, supported access types, and adapter type. Session IDs and verification results are never stored. Nonpersistent data points and all instruction points belong to their originating session and are removed when it ends. Adapter verification state, call stacks, variables, Debug Console output, and live sessions are intentionally transient. Debug Console content is retained only for the current window (up to 20 sessions and 128,000 characters per session); it is not sent to generic Output. A workspace switch flushes the old Memento, restores the new workspace state, and terminates all previous sessions.

The Breakpoints section edits expressions with F2 or its row action, and supports individual and bulk enable/disable and removal. Conditions and log messages are passed unchanged to DAP; their expression syntax belongs to the selected adapter. Unsupported breakpoint options produce an unverified point with a reason and are excluded from the adapter request. Each session serializes complete source and additional-family replacements, and discards verification replies for points edited or removed while a request was pending.

`ConfigurationManager` in `browser/debugConfigurationManager.ts` owns the launch catalog and selected configuration for the Debug service lifetime. `DebugService` publishes discovery results to this manager and reads the same catalog when starting a session; view recreation never resets the selection. Catalog replacement reconciles the selected ID to the current object and falls back to the first remaining configuration or compound.

`DebugViewPaneContainer` in `browser/debugViewlet.ts` owns the container title actions. The Part asks its `getActionViewItem` for `StartDebugActionViewItem` from `browser/debugActionViewItems.ts`; that item presents Start and the searchable configuration dropdown without retaining another selected ID. `browser/media/debugViewlet.css` owns this presentation, and `browser/debugIcons.ts` registers its semantic icons. The shared start command and the configure command in `browser/debugCommands.ts` read the manager, so F5, the menu, the title launcher, and opening the selected folder's launch.json agree. The title launcher explicitly starts a new session; F5 retains Continue behavior for a paused session.

`DebugViewPane` retains inspection, the unconfigured welcome, and active-session controls. `DebugConsoleViewPane` owns the Panel destination, session selector, clear action, accessible log, and REPL input. Keeping this presentation separate prevents DAP output from being mislabeled as an Output channel or mixed into Terminal PTY bytes.

`DebugViewPane` locates the first stack frame when inspecting a stopped session with an available line and column. Variable and source requests run independently, so a source-opening failure does not hide variables. Inspection results belong to one stopped session and selection generation; continuing, switching sessions or frames, or disposing the view retires pending results.

Variable editing requires `supportsSetVariable`, a stopped session, and an editable variable. F2 or double-click opens the shared `InputBox`; Enter submits and Escape cancels before submission. The DAP address is the **parent** `variablesReference` plus the variable name, not the variable's child reference. A successful response replaces the displayed value/type/child reference, retires expanded descendants, refreshes Watch, and restores row focus. An omitted response `variablesReference` means a scalar value. Adapter errors retain the draft with accessible validation. Retiring a pending edit discards its UI result without canceling the adapter mutation.

Pre-launch tasks must finish with `succeeded`; missing, ambiguous, failed, canceled, or status-unknown tasks prevent adapter launch. Post-debug task failures are reported without reviving the terminated session. Compound startup rolls back sessions already started when a later configuration fails. Extension adapter removal clears launch candidates before reparsing so stale commands cannot be launched.

An integrated `runInTerminal` request requires the created instance to be running before writing its command. An unavailable instance is closed and the reverse request receives a failure response; no command is retained for connection recovery. The error uses the current display language, and the user can restart debugging.

## Tests and modification impact

Run the Debug tests with the desktop unit runner, or target the compiled files under `contrib/debug/test`. `debugSession.test.ts` covers DAP capabilities, inspection, and variable assignment requests. `debugService.test.ts` covers persistence, task lifecycle, compounds, multiple sessions, and canonical factory resolution. `repl.test.ts` covers hidden-panel capture, evaluation, terminated-session retention, and clear. `debugAdapterManager.test.ts` covers multi-producer ownership and atomic replacement. `debugConfigurationManager.test.ts` covers explicit and extension-resolved adapters. `contrib/debug/test/browser/debugViewPane.test.ts` covers inspection lifetime and variable editing. The Playwright `debug.integration.spec.ts` exercises real editor positioning, input focus, validation, localization, narrow layout, and light/dark/high-contrast themes. `test/smoke/areas/debug/debug.spec.ts` exercises the Code product with a deterministic stdio DAP peer.

Debug-specific behavior in the generic editor, direct process execution in the Renderer, deriving Remote authority inside `DebugViewPane`, or live-session data in workspace persistence would signal ownership drift. Moving DAP execution to Rust follows the system design's migration boundary and must retire the corresponding TypeScript execution owner in the same behavior slice.

`DisassemblyViewInput` selects the central `DisassemblyView` editor. Call Stack and the Open Disassembly View command open it for an adapter advertising `supportsDisassembleRequest`. It follows the focused paused frame, browses 50-instruction windows, jumps to addresses, displays bytes and symbols, opens local/Remote/adapter-owned source locations, and toggles instruction breakpoints with F9. DAP byte offsets and instruction offsets remain distinct. Active disassembly retains editor focus across pauses; F10/F11/Shift+F11 send `granularity: instruction` only when the adapter supports stepping granularity. Continuing, changing frames/sessions, clearing input, or disposing the pane invalidates pending disassembly replies. Accessible Help/View and `accessibility.verbosity.disassembly` share the Workbench accessibility path.

`registerDebugConfigurationProviders` binds callbacks to an owned, replaceable registration. Initial templates are validated before `DebugViewPane` creates a launch document. Both trigger kinds participate in launch resolution; type-specific callbacks precede wildcard callbacks. Replacement or retirement of an existing provider, workspace replacement, or service disposal abort pending calls. Adding a provider retains unchanged owners and does not revoke an in-flight launch. An undefined resolution cancels startup before Tasks or adapter creation. A null resolution also opens the selected workspace folder’s launch.json through the shared configure command, preserving existing content and focus. Both resolution stages retain the distinction through an explicit Host result envelope. The extension startDebugging call resolves false for a provider cancellation; cancellation of the invocation itself still rejects. Folderless resolution has no folder launch file to open. Provider changes are reevaluated for a new session or restart, and the original configuration stays unchanged. The Host bridge forwards the canonical folder URI, name, and index rather than reconstructing a folder from a path.

## Current limitations

Function creation uses the Breakpoints toolbar. Data creation queries `dataBreakpointInfo` with the variable parent reference and selected frame, then offers only the adapter-supported read/write/readWrite access types. Instruction creation uses the selected frame instruction reference with an editable byte offset. The respective DAP replacement requests are capability-gated; session addresses are never sent to another session. Adapters use stdio processes, TCP servers, named pipes or inline implementations. Live session recovery and console history do not survive a restart. Declarative debugger discovery is supported, while arbitrary VS Code Debug extension APIs require the separately planned full Extension Host boundary.

Tasks and Debug share ConfigurationResolverService for environment, workspace, command/input, scalar configuration, user-home and selected-folder cwd variables. Paths and separators follow the execution host through PathService; nested command and configuration references resolve through the same expression. Active-file paths and metadata, selected text, and cursor line/column use one snapshot of the canonical Editor and CodeEditor owners before host reads or interaction. `${workspaceRoot}` and `${workspaceRootFolderName}` use the same Workspace resolution as their current equivalents. Debugger `variables` declarations map `${command:alias}` to their contributed command through the shared resolver. The selected debug type supplies the mapping after provider redirection; repeated aliases run once per start, restart reads the current catalog, and cancellation stops before pre-launch Tasks or adapter creation. Metadata-only debugger declarations retain mappings independently of adapter factories. Folderless `${cwd}` and editor installation paths still require additional execution context.

`runInTerminal.env` shares the terminal spawn contract with Tasks: strings override the child environment and `null` removes inherited keys. Environment values do not enter Shell command text. Executable adapter descriptors also accept child cwd and environment overrides; cwd stays beneath the authorized root. Web and Electron retain the selected directory identity for subsequent transport operations. An adapter initialized after workspace change or service disposal is disconnected before publication.

Pre-launch and post-debug tasks use TaskService's shared exit/readiness wait. Background
compilation can become ready while the process stays alive; error diagnostics still
prevent adapter startup. Cancellation stops the wait and its task. Catalog refreshes
do not revoke the immutable launch snapshot; workspace and factory retirement do.

Session disposal closes its adapter process once, including direct DebugService disposal and late initialization after workspace retirement. Compound stop listeners belong to the member session records and are released when those sessions finish.

## Full VS Code compatibility target

| Contract area              | Current behavior and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and adapters | Static executables, Host RPC asynchronous descriptors, variable resolution and folder-qualified compounds are implemented. Configuration providers resolve before and after variable substitution; Initial providers supply launch.json templates. The Select and Start command merges configured entries with Dynamic provider results, preserves workspace-folder identity and cancels discovery when the picker closes or the workspace changes. Configuration discovery activates onDebug and the requested Initial/Dynamic phase; launch activates onDebug and the selected type’s onDebugResolve before taking its provider lifetime. Dormant owners are admitted and started by the App Server Host with their exact activation generation. A redirected type activates its dormant owner before parsing and invoking the target callbacks; unchanged provider and factory owners retain their identity across that activation. Later extension registration remains incomplete. |
| Session and extension API  | Stable session identity, name updates, start/end/active/custom events, custom requests, source/function breakpoint APIs and per-session DAP breakpoint queries are implemented. Adapter tracker factories and their six lifecycle/message hooks are implemented. Parent identity, managed lifecycle, `noDebug`, console merging and stack-item events are implemented; other session options and the complete namespace remain incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Transport and recovery     | Stdio process, TCP server and OS named-pipe ownership, cancellation and disposal are implemented. Connections share DAP framing and bounded output with processes; close awaits reader cancellation and writer shutdown. Inline adapters use the same Rust request client through bounded Host IO queues and awaited implementation cleanup without spawning an adapter process. DAP startDebugging reverse requests create independent child sessions through the same configuration, task and adapter owners. Live session recovery remains incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tasks integration          | Startup/shutdown share TaskService, background matcher readiness, diagnostic failure checks and cancellation. Contributed matcher/pattern registries are implemented; broader task presentation, file-location search and run policies remain incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The implemented Host RPC bridge is not evidence that arbitrary VS Code debugger extensions can run unchanged.

`MainThreadDebugService` exposes the canonical DebugService through authenticated
session, custom-request, name and breakpoint operations. The `debugEvents`
registration requires the debug-adapter capability. Ordered queues are bounded to
64 callbacks and belong to one extension incarnation. Custom DAP events are observed
before initialization completes; termination follows adapter close acknowledgement.
The standard `vscode.debug` facade preserves session and breakpoint object identity,
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

Debug startup saves through `IEditorService` and retained `EditorGroupView` panes before activation, providers or preLaunchTask. `debug.saveBeforeStart` selects no saves, file-backed saves, or file-backed saves plus active untitled Save As. A cancelled Save As, a dirty result, a save failure, or a workspace change prevents adapter launch. Child sessions do not repeat the parent save; extensions can use `suppressSaveBeforeStart`. The editor owns save participants and read-only recovery; Debug never writes dirty buffers directly.

The current inspection chain is `DebugViewPane` → `IDebugSession.inspectStack`,
`inspectFrame`, `evaluateWatchExpressions` (or child `variables`) → `RawDebugSession`
→ platform domain capability → connection-owned App Server service → Rust manager.
The view no longer sequences threads/stack/scopes/variables/evaluate requests.
`common/debug.ts` remains the frontend contract; generated transport DTOs stay in
the platform adapter. These are responsibility slices in the existing VS Code
counterpart files, not a claim that the aggregate sidebar already matches every
upstream view or public model API.

The Rust query checks `inspectionRevision` before issuing DAP, and fences both
continuations and retained completions. Selection and editor focus are client-owned.
Breakpoint snapshots carry an edit version and pending/confirmed status. The facade
cannot rebuild bindings or replay replacement requests; generic family request
bypasses are refused by Rust. Adapter-originated catalogue changes are published
only after the backend binding exists, preserving extension observer ordering.

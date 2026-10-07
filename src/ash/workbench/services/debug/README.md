# Workbench Debug service

The system-level ownership and current user-visible status are documented in [`docs/debugging.md`](../../../../../docs/debugging.md). This README owns the Renderer implementation contract.

## Ownership and execution path

`common/debugService.ts` is the canonical frontend contract. `workbench/contrib/debug/browser/debugService.ts` implements `DebugService` and owns launch/compound configuration, source, function, data, and instruction breakpoints and workspace-persisted Watch expressions, exception-breakpoint selection, task orchestration, the active session, and the collection of concurrent sessions. `DebugAdapterSession` owns DAP request pairing, capabilities, initialization, breakpoint synchronization, thread/stack/scope/recursive-variable inspection, `setVariable`, `evaluate`, `source`, execution control, output, termination, and reverse requests. `common/debugConsoleService.ts` is the separate Debug Console contract; `DebugConsoleService` subscribes before any UI is visible, retains bounded per-session DAP/REPL output, and keeps terminated sessions inspectable. The same contribution implementation validates `runInTerminal` and delegates presentation to `ITerminalService`. Its stable dependencies use constructor DI; the window registers its selected DAP process capability, including explicit unavailability. The shared `IDebugAdapterFactorySource` resolves the canonical factory registry.

The call path is:

```text
DebugService.start / startDebugging / startCompound
  -> preLaunchTask through ITaskService
  -> DebugAdapterSession.start
  -> IDebugAdapterProcessService.start
  -> initialize + launch/attach
  -> breakpoints + exception breakpoints + configurationDone
  -> session events and inspection requests
  -> disconnect/adapter exit
  -> postDebugTask through ITaskService
```

`DebugBreakpointDecorationProvider` is the only Debug-to-editor adapter. The editor owns a generic composable gutter contract and must not import Debug semantics. `DebugAdapterSession` also converts adapter source paths into URIs on the current local or Remote Workspace authority; `DebugViewPane` consumes that domain resource and never reinterprets a Remote path as local `file://`. Process lifetime, bounded DAP framing, trust retirement, and connection ownership remain backend responsibilities.

## Configuration and extension integration

`startDebugging` also accepts a caller-supplied configuration, used by TestingService for an exact compiled test. It does not write `launch.json`; restart retains that configuration. F9 invokes `editor.debug.action.toggleBreakpoint` through the current editor and the same breakpoint owner. LLDB-DAP zero-sequence responses and events retain their adapter identity; request pairing uses `request_seq`, independently of the backend output cursor. Stack frames retain DAP zero line/column values for unavailable positions; inspecting them does not invent a source location. A view opened after a session has stopped immediately reads the existing session.

Each `.vscode/launch.json` configuration can declare an explicit `debugAdapter.program` plus `debugAdapter.args`. If it omits `debugAdapter`, `parseLaunchConfigurationDocument` resolves the configuration `type` through the canonical `DebugAdapterFactoriesRegistry`. Declarative extensions register one caller-owned factory set for the program/argument descriptors contributed through `contributes.debuggers`; other runtime producers use independent registrations.

All remaining configuration properties are forwarded to the adapter after `${workspaceFolder}` and `${workspaceFolderBasename}` expansion. The value comes from the current Workspace URI: native filesystem syntax for `file:` and decoded POSIX syntax for Remote. Workbench-only `preLaunchTask` and `postDebugTask` fields are removed before the DAP launch/attach request. Compounds resolve configuration IDs or unique names and may request `stopAll` behavior.

`DebugAdapterFactoryRegistry` discovers bounded executable descriptors only. It does not execute extension JavaScript or imply a full Extension Host.

## Durability and failure semantics

DebugService validates and normalizes its persisted schema, updates the workspace object returned by `Memento.getMemento`, and calls `saveMemento` on the Storage save lifecycle. Memento owns scoped JSON storage and explicit reload; DebugService owns external-change handling and preserves pending local edits. It stores source and function breakpoints, data breakpoints explicitly marked `canPersist` by the adapter, Watch expressions, and per-adapter-type exception filters in workspace scope. Version 1 source-only state migrates to version 2. Durable points retain enabled state and conditions; source points also retain log messages. Data points retain their opaque `dataId`, supported access types, and adapter type. Session IDs and verification results are never stored. Nonpersistent data points and all instruction points belong to their originating session and are removed when it ends. Adapter verification state, call stacks, variables, Debug Console output, and live sessions are intentionally transient. Debug Console content is retained only for the current window (up to 20 sessions and 128,000 characters per session); it is not sent to generic Output. A workspace switch flushes the old Memento, restores the new workspace state, and terminates all previous sessions.

The Breakpoints section edits expressions with F2 or its row action, and supports individual and bulk enable/disable and removal. Conditions and log messages are passed unchanged to DAP; their expression syntax belongs to the selected adapter. Unsupported breakpoint options produce an unverified point with a reason and are excluded from the adapter request. Each session serializes complete source and additional-family replacements, and discards verification replies for points edited or removed while a request was pending.

The Run and Debug sidebar owns inspection and execution controls. `DebugConsoleViewPane` owns the VS Code-shaped Panel destination, session selector, clear action, accessible log, and REPL input. Keeping this projection separate prevents DAP output from being mislabeled as an Output channel or mixed into Terminal PTY bytes.

`DebugViewPane` locates the first stack frame when inspecting a stopped session with an available line and column. Variable and source requests run independently, so a source-opening failure does not hide variables. Inspection results belong to one stopped session and selection generation; continuing, switching sessions or frames, or disposing the view retires pending results.

Variable editing requires `supportsSetVariable`, a stopped session, and an editable variable. F2 or double-click opens the shared `InputBox`; Enter submits and Escape cancels before submission. The DAP address is the **parent** `variablesReference` plus the variable name, not the variable's child reference. A successful response replaces the displayed value/type/child reference, retires expanded descendants, refreshes Watch, and restores row focus. An omitted response `variablesReference` means a scalar value. Adapter errors retain the draft with accessible validation. Retiring a pending edit discards its UI result without canceling the adapter mutation.

Pre-launch tasks must finish with `succeeded`; missing, ambiguous, failed, canceled, or status-unknown tasks prevent adapter launch. Post-debug task failures are reported without reviving the terminated session. Compound startup rolls back sessions already started when a later configuration fails. Extension adapter removal clears launch candidates before reparsing so stale commands cannot be launched.

An integrated `runInTerminal` request requires the created instance to be running before writing its command. An unavailable instance is closed and the reverse request receives a failure response; no command is retained for connection recovery. The error uses the current display language, and the user can restart debugging.

## Tests and modification impact

Run the Debug tests with the desktop unit runner, or target the compiled files under `services/debug/test`. `debugAdapterSession.test.ts` covers DAP capabilities, inspection, and variable assignment requests. `debugService.test.ts` covers persistence, task lifecycle, compounds, multiple sessions, and canonical factory resolution. `debugConsoleService.test.ts` covers hidden-panel capture, evaluation, terminated-session retention, and clear. `debugAdapterFactory.test.ts` covers multi-producer ownership and atomic replacement. `launchConfiguration.test.ts` covers explicit and extension-resolved adapters. `contrib/debug/test/browser/debugViewPane.test.ts` covers inspection lifetime and variable editing. The Playwright `debug.integration.spec.ts` exercises real editor positioning, input focus, validation, localization, narrow layout, and light/dark/high-contrast themes. `test/smoke/areas/debug/debug.spec.ts` exercises the Code product with a deterministic stdio DAP peer.

Adding DAP client state to the backend, Debug-specific behavior to the editor, direct process execution to the Renderer, deriving Remote authority inside `DebugViewPane`, or live-session data to workspace persistence would signal ownership drift.

`DisassemblyViewInput` selects the central `DisassemblyView` editor. Call Stack and the Open Disassembly View command open it for an adapter advertising `supportsDisassembleRequest`. It follows the focused paused frame, browses 50-instruction windows, jumps to addresses, displays bytes and symbols, opens local/Remote/adapter-owned source locations, and toggles instruction breakpoints with F9. DAP byte offsets and instruction offsets remain distinct. Active disassembly retains editor focus across pauses; F10/F11/Shift+F11 send `granularity: instruction` only when the adapter supports stepping granularity. Continuing, changing frames/sessions, clearing input, or disposing the pane invalidates pending disassembly replies. Accessible Help/View and `accessibility.verbosity.disassembly` share the Workbench accessibility path.

## Current limitations

Function creation uses the Breakpoints toolbar. Data creation queries `dataBreakpointInfo` with the variable parent reference and selected frame, then offers only the adapter-supported read/write/readWrite access types. Instruction creation uses the selected frame instruction reference with an editable byte offset. The respective DAP replacement requests are capability-gated; session addresses are never sent to another session. Adapter transport is stdio only. Live session recovery and console history do not survive a restart. Declarative debugger discovery is supported, while arbitrary VS Code Debug extension APIs require the separately planned full Extension Host boundary.

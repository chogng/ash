# Workbench Debug service

The system-level ownership and current user-visible status are documented in [`docs/debugging.md`](../../../../../../docs/debugging.md). This README owns the Renderer implementation contract.

## Ownership and execution path

`common/debugService.ts` is the canonical frontend contract. `DebugService` owns launch/compound configuration, workspace-persisted line breakpoints and Watch expressions, exception-breakpoint selection, task orchestration, the active session, and the collection of concurrent sessions. `DebugAdapterSession` owns DAP request pairing, capabilities, initialization, breakpoint synchronization, thread/stack/scope/recursive-variable inspection, `evaluate`, `source`, execution control, output, termination, and reverse requests. `common/debugConsoleService.ts` is the separate Debug Console contract; `DebugConsoleService` subscribes before any UI is visible, retains bounded per-session DAP/REPL output, and keeps terminated sessions inspectable. `DebugTerminalLauncher` validates `runInTerminal` and delegates presentation to `ITerminalService`.

The call path is:

```text
DebugService.start / startCompound
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

Each `.vscode/launch.json` configuration can declare an explicit `debugAdapter.program` plus `debugAdapter.args`. If it omits `debugAdapter`, `parseLaunchConfigurationDocument` resolves the configuration `type` through the canonical `DebugAdapterFactoriesRegistry`. Declarative extensions register one caller-owned factory set for the program/argument descriptors contributed through `contributes.debuggers`; other runtime producers use independent registrations.

All remaining configuration properties are forwarded to the adapter after `${workspaceFolder}` and `${workspaceFolderBasename}` expansion. The value comes from the current Workspace URI: native filesystem syntax for `file:` and decoded POSIX syntax for Remote. Workbench-only `preLaunchTask` and `postDebugTask` fields are removed before the DAP launch/attach request. Compounds resolve configuration IDs or unique names and may request `stopAll` behavior.

`DebugAdapterFactoryRegistry` discovers bounded executable descriptors only. It does not execute extension JavaScript or imply a full Extension Host.

## Durability and failure semantics

`Memento<PersistedDebugState>` stores line breakpoints, Watch expressions, and per-adapter-type exception filters in workspace scope. Adapter verification state, call stacks, variables, Debug Console output, and live sessions are intentionally transient. Debug Console content is retained only for the current window (up to 20 sessions and 128,000 characters per session); it is not sent to generic Output. A workspace switch flushes the old Memento, restores the new workspace state, and terminates all previous sessions.

The Run and Debug sidebar owns inspection and execution controls. `DebugConsoleViewPane` owns the VS Code-shaped Panel destination, session selector, clear action, accessible log, and REPL input. Keeping this projection separate prevents DAP output from being mislabeled as an Output channel or mixed into Terminal PTY bytes.

Pre-launch tasks must finish with `succeeded`; missing, ambiguous, failed, canceled, or status-unknown tasks prevent adapter launch. Post-debug task failures are reported without reviving the terminated session. Compound startup rolls back sessions already started when a later configuration fails. Extension adapter removal clears launch candidates before reparsing so stale commands cannot be launched.

## Tests and modification impact

Run the Debug tests with the desktop unit runner, or target the compiled files under `services/debug/test`. `debugAdapterSession.test.ts` covers DAP capabilities and inspection requests. `debugService.test.ts` covers persistence, task lifecycle, compounds, multiple sessions, and canonical factory resolution. `debugConsoleService.test.ts` covers hidden-panel capture, evaluation, terminated-session retention, and clear. `debugAdapterFactory.test.ts` covers multi-producer ownership and atomic replacement. `launchConfiguration.test.ts` covers explicit and extension-resolved adapters.

Adding DAP client state to the backend, Debug-specific behavior to the editor, direct process execution to the Renderer, deriving Remote authority inside `DebugViewPane`, or live-session data to workspace persistence would signal ownership drift.

## Current limitations

The current breakpoint model is line-based; conditional, log, function, data, and instruction breakpoints are not yet represented. Adapter transport is stdio only. Live session recovery and console history do not survive a restart. Declarative debugger discovery is supported, while arbitrary VS Code Debug extension APIs require the separately planned full Extension Host boundary.

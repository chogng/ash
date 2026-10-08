# Workbench tasks service

`workbench/services/tasks` owns the shared task contract and configuration parsing.
`workbench/contrib/tasks/browser/taskService.ts` owns discovery, run state, and
Terminal execution, and installs the service through the Code-selected service
registry. Its stable dependencies use constructor DI. The Terminal remains the
sole frontend instance and output owner; Rust owns PTY processes.

`ITaskRun.terminalId` identifies the UI instance without importing the Terminal
contribution into a shared service contract. Tasks and Testing views resolve this
identity through the Terminal service.

## Current contract

| Symbol                | Responsibility                                                                          | Must not own                                                 |
| --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ITaskService`        | Enumerate current workspace tasks, start a selected task, terminate an active run       | PTY processes, shell rendering, editor state                 |
| `TaskService`         | Read task files through `IFileService`, create a named terminal, project command status | Host filesystem paths, automatic command execution           |
| `parseWorkspaceTasks` | Preserve `tasks.json` and declare unsupported execution settings                        | Variable expansion beyond the documented workspace variables |
| `TaskRun`             | Bind the first terminal command identity to one run and retain its final status         | Terminal output buffering or shell integration parsing       |

The execution path is `Run Task` or `TasksViewPane` → `TaskService.run` →
`ITerminalService.createTerminal` → one explicit terminal write. The task is
never executed while discovering or parsing configuration. The Terminal and
App Server continue to own workspace-root process isolation and command-status
events.

Discovery currently reads `.vscode/tasks.json` version `2.0.0`, including tasks
whose execution settings are not supported, `package.json` scripts with lockfile-based npm/pnpm/yarn selection, and
the conventional Cargo check/build/test/run commands when `Cargo.toml` exists.
Each configured task retains its frozen original definition and global defaults,
including unknown extension metadata. Supported shell tasks run through the
integrated terminal. `process` and provider-specific configuration types remain
visible but cannot run until their real execution contracts are implemented;
dynamic `TaskProvider` shell commands keep their existing supported contract.

Known unsupported execution settings are listed on the task and rejected before
creating a terminal: nonempty dependencies and problem matchers, background
readiness, cwd/env/shell overrides, platform overrides, explicit presentation
settings, unsupported run policies, expansion-sensitive or structured arguments,
and unresolved command variables. Workspace folder variables in the command
retain their existing expansion; arguments that need variable-aware quoting
remain unavailable until the shell quoting contract is implemented. Empty dependency,
matcher and env collections, false background, default runOn and true
reevaluateOnRerun do not need capabilities and are accepted. Unknown metadata is
retained without guessing that it changes execution. Ash does not claim complete
VS Code Tasks compatibility. A supported shell task must still declare a nonempty
command; arguments cannot become the executable when the command is missing.

## Failure and lifecycle semantics

File change notifications refresh the catalog and update an open Run Task picker.
The picker releases its catalog subscription when hidden. Dispatch also rereads current
configuration before resolving the selected task, so a watcher delay or a failed
refresh retaining the last good catalog cannot execute old semantics. Removed or
changed commands are rejected; unchanged commands use the latest capability
validation. Unsupported execution reports a localized error and creates no run,
terminal or process. A changed catalog clears the previous execution error in the
Tasks view. Correcting the configuration allows a later retry. Run Task
command failures appear through the existing notification service; Tasks view
failures appear in its status region. Terminal success, failure, cancellation, disconnection, and exit are
projected into `ITaskRun`; terminating a run closes its terminal. Completed
terminal instances remain visible until the user closes them so output is not
discarded.

After creation, a task requires a running terminal before publishing its run or
writing the command. If the terminal is already disconnected, reconnecting,
exited, or in error, the task closes the instance it created and rejects startup.
No command is retained for connection recovery; the user can run the task again.

Current limitations are deliberate: there is no dependency graph,
background-task readiness matcher, problem matcher, custom environment, or
task-specific working directory yet. The current Terminal create contracts expose
only the authorized directory identity, dimensions and server shell profile.
Adding real process argv, spawn cwd and env requires the Terminal/exec-server
owners to extend their shared contract. Shell `cd`/`export` prefixes and a
separate Tasks process runtime would not supply equivalent semantics. Debug and Testing integrations may consume
`ITaskService`, but must not bypass it with another process runtime.

Tests live beside the parser and browser service. Changes to discovery must run
the workspace-task tests; changes to execution must also run the Terminal
service tests and the Code renderer build.

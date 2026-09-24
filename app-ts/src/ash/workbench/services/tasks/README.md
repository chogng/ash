# Workbench tasks service

`workbench/services/tasks` owns task discovery and execution state for the Code
product. The user-facing contribution lives in `workbench/contrib/tasks`; the
Terminal remains the sole process and output owner.

## Current contract

| Symbol | Responsibility | Must not own |
| --- | --- | --- |
| `ITaskService` | Enumerate current workspace tasks, start a selected task, terminate an active run | PTY processes, shell rendering, editor state |
| `TaskService` | Read task files through `IFileService`, create a named terminal, project command status | Host filesystem paths, automatic command execution |
| `parseWorkspaceTasks` | Validate the supported `tasks.json` shell/process subset | Variable expansion beyond the documented workspace variables |
| `TaskRun` | Bind the first terminal command identity to one run and retain its final status | Terminal output buffering or shell integration parsing |

The execution path is `Run Task` or `TasksViewPane` → `TaskService.run` →
`ITerminalService.createTerminal` → one explicit terminal write. The task is
never executed while discovering or parsing configuration. The Terminal and
App Server continue to own workspace-root process isolation and command-status
events.

Discovery currently supports `.vscode/tasks.json` version `2.0.0` shell/process
tasks, `package.json` scripts with lockfile-based npm/pnpm/yarn selection, and
the conventional Cargo check/build/test/run commands when `Cargo.toml` exists.
Unsupported task types fail configuration loading instead of being silently
reinterpreted.

## Failure and lifecycle semantics

Changing task configuration invalidates the cached catalog and causes a fresh
read. A task selected from an older catalog is rejected before terminal
creation. Terminal success, failure, cancellation, disconnection, and exit are
projected into `ITaskRun`; terminating a run closes its terminal. Completed
terminal instances remain visible until the user closes them so output is not
discarded.

Current limitations are deliberate: there is no dependency graph,
background-task readiness matcher, problem matcher, custom environment, or
task-specific working directory yet. Debug and Testing integrations may consume
`ITaskService`, but must not bypass it with another process runtime.

Tests live beside the parser and browser service. Changes to discovery must run
the workspace-task tests; changes to execution must also run the Terminal
service tests and the Code renderer build.

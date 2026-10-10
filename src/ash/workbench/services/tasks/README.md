# Workbench tasks service

`workbench/services/tasks` owns the shared task contract and configuration parsing.
`workbench/contrib/tasks/browser/taskService.ts` owns discovery and installs the
service through the Code-selected service registry. `TerminalTaskSystem` owns
command resolution, run state, and Terminal execution. Both use constructor DI. The Terminal remains the
sole frontend instance and output owner; Rust owns PTY processes.

`ITaskRun.terminalId` identifies the UI instance without importing the Terminal
contribution into a shared service contract. Tasks and Testing views resolve this
identity through the Terminal service.

Standard extensions can start built-in Tasks commands through `commands.executeCommand`.
The request reaches the initiating client's canonical CommandService and then the existing
TaskService. Void command results return `undefined`; explicit JSON null and falsy values
retain their meaning. Command completion does not imply that the task process has exited.

`MainThreadTask` exposes extension task queries and execution handles through the existing
TaskService. `fetchTasks` filters version and definition type without execution;
`executeTask` accepts fetched catalog identities or explicitly constructed shell/process/custom Tasks.
Unmodified catalog dispatch rereads configuration; explicit dispatch validates through the same TaskService.
Edits to a fetched shell/process Task dispatch its public snapshot as an explicit Task,
with literal argv and stable TaskExecution identity. Definition-only Tasks reach the
registered provider's dispatch-time resolveTask callback.
Edits to a fetched CustomExecution dispatch the edited metadata with the current
catalog task's callback. The provider retains its invocation authority and PTY
ownership; the caller's observer owns cancellation of the explicit run. Missing
or changed catalog execution types are rejected before a callback can run. A new
Task using the same opaque fetched execution retains the original catalog callback
identity and dispatches the new metadata through the caller's lifetime. Direct
invocation of the opaque execution's callback remains unsupported.
Configured groups and default rules retain priority over the resolving provider's suggestions,
including groups selected from root or per-task platform blocks and a definition-only
extension Task's explicit group. An explicit plain group does
not inherit the provider's default flag. The parser records group presence after merging the
selected platform; dispatch consumes that provenance without reinterpreting raw JSON.
Explicit Tasks belong to the authenticated extension incarnation and are canceled when it retires.
`runOptions.reevaluateOnRerun` is retained in task queries and execution events. Rerun Last Task
uses the current configuration and preserves previous variable values only when this option is false.
New references still resolve, including nested references in cached command/input values. Ordinary Run Task
resolves afresh. The execution owner keeps weak per-run snapshots and clears the last run on workspace
change; explicit task reruns retain the original extension authority and retirement cleanup.
Provider source labels and numeric TaskScope values survive queries; folder-scoped tasks resolve
the exact current workspace folder and dispatch there. An outside-workspace scope is rejected.
`TaskExecution.terminate`, `taskExecutions`, and the four start/end and process start/end
events share one execution identity. Sequence numbers prevent late query or execution replies
from restoring a completed run. Process end is sent after the process owner acknowledges
release, even when the UI records cancellation earlier. Retiring an extension observer aborts
its queued callbacks; completion does not migrate to a replacement incarnation.
Custom PTY completion waits for its brokered release acknowledgment and emits no process events.
`workbench.action.tasks.build` and `workbench.action.tasks.test` use the current catalog. Configured `group.isDefault` globs match the active file relative to its workspace folder without case sensitivity and take priority over boolean defaults. A unique match or boolean default runs directly; multiple matches restrict the picker, and no match falls back to boolean defaults or the group. Folderless editors use the same fallback. Extension TaskGroup snapshots expose a glob as `isDefault: false`, preserving the public boolean contract. The picker follows catalog changes and Escape cancels selection. Presentation and automatic run policies remain incomplete.

## Current contract

| Symbol                | Responsibility                                                                          | Must not own                                                 |
| --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ITaskService`        | Enumerate current workspace tasks, start a selected task, terminate an active run       | PTY processes, shell rendering, editor state                 |
| `TaskService`         | Read task files through `IFileService`, own providers, catalog freshness and dependency graphs | PTY execution and terminal run state |
| `TerminalTaskSystem`  | Resolve shell/process/custom execution, own run status and listeners | Task discovery and provider state |
| `parseWorkspaceTasks` | Preserve `tasks.json` and declare unsupported execution settings                        | Variable expansion or command execution |
| `TaskRun`             | Bind the first terminal command identity to one run and retain its final status         | Terminal output buffering or shell integration parsing       |

The execution path is `Run Task` or `TasksViewPane` → `TaskService.run` →
`TerminalTaskSystem.run` → `IConfigurationResolverService.resolveWithInteractionReplace` →
`ITerminalService.createTerminal` → a process spawn, custom PTY, or legacy terminal write. The task is
never executed while discovering or parsing configuration. The Terminal and
App Server continue to own workspace-root process isolation and command-status
events.

Discovery currently reads `.vscode/tasks.json` version `2.0.0`, including tasks
whose execution settings are not supported, `package.json` scripts with lockfile-based npm/pnpm/yarn selection, and
the conventional Cargo check/build/test/run commands when `Cargo.toml` exists.
Each configured task retains its frozen original definition and global defaults,
including unknown extension metadata. Supported shell tasks run through the
integrated terminal. Command-only configurations use the same backend shell
execution as standard ShellExecution, with the resolved command line as launch
data. Tasks do not inject commands or exit wrappers into an interactive shell.
Process tasks preserve literal argv, including empty arguments,
and use the backend process owner. Provider-specific tasks call `resolveTask` at dispatch
and preserve their definition and configured options. Dynamic providers support shell,
process and CustomExecution. Discovery first activates admitted dormant owners through the shared ExtensionService and the fenced App Server Host API. Provider registrations completed by this activation are read in the same discovery; workspace changes still cancel it. Standard manifests derive onTaskType events from contributed task definitions. Activation failure rejects discovery instead of silently presenting an empty provider catalog. Host RPC providers return environment values in `env`;
configured and provider tasks share validation.

Configured `presentation.panel` selects shared, dedicated, or new task terminals;
omitting it uses shared.
Shared terminals reuse an idle task screen within the same workspace folder;
dedicated terminals additionally require the same task identity. Concurrent runs
receive separate screens. Reuse replaces the process, cwd and environment while
preserving the UI instance and output; `presentation.clear` clears its buffer first.
The task's recorded PID continues to identify its own process after screen reuse.
CustomExecution release acknowledgment is part of completion, so a visible exit
cannot make a screen reusable before its producer has released resources.
Workspace changes and instance removal discard reuse eligibility. Extension
`TaskPanelKind`, `TaskRevealKind` and `presentationOptions` reach the same execution owner,
survive `fetchTasks` and provider resolution, and are retained when a fetched
shell/process Task is edited.

`presentation.reveal` defaults to always, opens the terminal without moving focus,
and honors `focus` when true. Never keeps output hidden even with focus requested.
Silent reveals the terminal on an error diagnostic or failed exit. `close` removes
the completed task terminal after producer release; it cannot close another run.
Configured options override provider options per field. TaskService owns the shared
Tasks Output channel and discovery events; it creates the execution system on first
dispatch, after view registration. `revealProblems` defaults to never. Always opens
Problems before execution and takes priority over terminal reveal. OnProblem opens
Problems after a foreground task reports any diagnostic, including warnings; a
background matcher opens and focuses Problems when its completed cycle has errors.
Failed exits without matched diagnostics still honor silent terminal reveal.
Standard extensions retain this configuration-only `revealProblems` policy when
editing and executing a fetched Task, including replacement of its public presentation
options. The public Task API does not expose the configuration-only field.
`presentation.echo` defaults to true. The resolved process program and literal argv,
or the shell command line, appear before process output. Echo is display text and
never enters stdin or problem matchers. Reusing a terminal replaces the old echo
policy; false suppresses the command while retaining process output and exit.
CustomExecution has no executable command to echo. `showReuseMessage` defaults to
true. Shared/dedicated terminals display the reuse notice, new terminals display a
close notice, and `close: true` suppresses both. Disabling the reuse notice retains
the completed terminal's key-to-close behavior. Reuse replaces the exit policy.
Terminal groups remain incomplete.

Known unsupported execution settings are listed on the task and rejected before
creating a terminal: unavailable execution-host platform facts, other presentation
settings, unsupported run policies,
and unsupported host variables. `${env:NAME}`, `${workspaceFolder}` and `${workspaceFolderBasename}`
and `${command:...}` / `${input:...}` in the command and environment keys and values are resolved by the shared configuration resolver before creating a terminal. `${config:...}` reads current scalar values from ConfigurationService; `${userHome}` requires execution-host home facts. `${cwd}` uses the selected folder, and `${pathSeparator}` / `${/}` use its filesystem rules. File paths and drive letters follow PathService’s execution-host facts, independently of the renderer’s operating system. Each command or input variable is evaluated once per invocation; a new run evaluates it again. Configured inputs are read through FileService from the selected folder’s `.vscode/tasks.json` at dispatch. `promptString` and `pickString` reuse Quick Input with defaults, labels, password masking and keyboard cancellation; command inputs pass their declared `args` to CommandService. Nested references in input results resolve from the same invocation cache. Invalid or duplicate referenced definitions fail before interaction; a workspace switch or resolver disposal closes its own prompt and cancels dispatch. Cancellation creates no terminal or run. Task command handlers receive the ordered array of requested variable strings after noninteractive substitution, matching standard Tasks resolution. Callback authority and absent internal execution fields do not cross the Host JSON boundary. The returned Map populates the existing execution expression and rerun snapshot; retained task metadata never invokes command variables.
The shared resolver also implements `resolveWithEnvironment`, `resolveWithInteraction` and
`contributeVariable`. An explicit environment belongs to one resolution and does not acquire
ambient host values; Windows names use the execution host's case rules. Interaction maps
and replacements share the same expression cache, cancellation and nested-variable handling.
The Task owner contributes `${defaultBuildTask}`: one default build returns its label; otherwise
Quick Input selects a build label without executing it. Cancel, workspace replacement or disposal
closes that selection and cancels the surrounding launch before execution.
Registered contributed variables are accepted during Task discovery and resolve once at dispatch;
unregistered names remain unsupported. The resolver owns callbacks until disposal and rejects
duplicate registrations. An explicit `ConfigurationTarget` selects input definitions from the
canonical configuration service when that section is registered. Workspace `tasks.json` and
`launch.json` retain the FileService path for folder inputs. Global task/launch configuration
sections and workspace-scoped settings still need their own configuration integration.

Named selectors such as `${workspaceFolder:Server}` refer to the current Workspace folder names;
a missing folder or a workspace change during resolution or terminal creation rejects dispatch without sending a command. A terminal returned after invalidation is closed without publishing a run.
Structured shell commands and arguments retain their boundaries through variable resolution.
Dispatch then applies automatic, strong, weak or escape quoting for the selected execution-host
profile. Explicit `options.shell` executable and arguments become a process spawn through the
same Terminal owner; provider `ShellExecution` also preserves shell quoting overrides. Empty dependency,
matcher collections, false background, default runOn and true
reevaluateOnRerun do not need capabilities and are accepted. Unknown metadata is
retained without guessing that it changes execution. Ash does not claim complete
VS Code Tasks compatibility. A supported shell task must still declare a nonempty
command; arguments cannot become the executable when the command is missing.

`windows`, `osx` and `linux` blocks apply to the execution host OS reported by PathService.
Document defaults and their platform block are applied before task fields and their platform
block. Arguments replace their inherited array; cwd and environment values retain normal
variable resolution. Inactive blocks do not affect execution. Original configuration metadata
remains intact. If host OS facts are unavailable, platform-dependent tasks cannot start.

`options.env` merges document defaults with task values; an empty task object retains inherited keys and null removes a key from the child environment. Variables resolve against the selected authorized execution host before terminal creation. Missing environment values become empty strings. Nested references in resolved values are evaluated once per variable; raw shell dollar syntax stays data. The backend applies overrides to a copy of its frozen terminal environment; a task cannot mutate later terminals. Terminal relaunch retains the original spawn environment snapshot. The backend continues to exclude unrelated process secrets from its inherited environment; this policy differs from VS Code's unrestricted process environment.

Active-file metadata, relative paths, containing workspace folder, selected text and cursor
line/column are resolved from the canonical Editor and CodeEditor owners. The invocation
captures that snapshot before environment reads, commands or prompts can change the active
editor. Selected text uses the same variable resolution contract. Host path rules apply to file metadata;
`${workspaceRoot}` and `${workspaceRootFolderName}` retain the corresponding Workspace
behavior for older configurations. Missing editor, selection or containing folder fails
before process creation. Web and Electron process assertions cover the emitted arguments.

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
discarded. Completed runs release their terminal listeners while retaining their
readable result through `lastRun`.

Before a legacy shell write, a task requires a running terminal. A process or
explicit shell spawn may already have exited; its buffered output and exit code
still produce the run result. A late resize after process exit keeps the retained Terminal
size and exit code; it does not turn a completed task into a PTY error. A disconnected, reconnecting or unavailable terminal
is closed and startup is rejected.
No command is retained for connection recovery; the user can run the task again.

Dependency graphs are validated for missing/ambiguous references and cycles before
process creation. Sequential and parallel dependencies wait for exit or background
matcher readiness; diagnostics with errors prevent their parent. Failed dispatch
retires processes started by that graph. Terminating its root also terminates the
background dependencies it started; reused runs retain their original ownership.

Problem collectors decode ordered UTF-8 output, strip ANSI sequences from complete
lines, handle multiline/loop patterns, publish through MarkerService and clear stale
diagnostics when a new compilation begins. `$tsc`, `$tsc-watch`, `$gcc`, `$msCompile`,
`$gulp-tsc`, `$lessCompile`, `$go`, JSHint and ESLint compact/stylish matchers are supported.
Microsoft compiler diagnostics retain build prefixes, captured locations and codes,
subcategory/fatal/info severity and four-coordinate ranges. Captured `error`, `warning`,
`warn`, `info`, `hint` and `note` are case-insensitive; `E`, `W`, `I` shorthand is uppercase.
Other captured severity values, including `fatal error`, use the configured matcher severity.
Core named patterns include
`$cpp`, `$csc` and `$vb`; these are pattern references rather than standalone matchers.
Stylish diagnostic rows retain their file header while clearing the previous row's optional
captures. JSHint E/W/I codes retain their severity. Declarative extension `problemMatchers` and
`problemPatterns` support named references, inherited bases, multiline patterns and background
readiness. Registration replacement validates the complete set before publication; package
removal prevents future dispatch from using its names. Single patterns default to the
complete match as their message and have no inferred severity. Array patterns use only
explicit captures across entries. Missing columns in array patterns mark the complete
line. Location-kind diagnostics without a captured location are omitted; zero or invalid
numeric coordinates normalize to the first line/column without discarding the diagnostic.
File-only kind ignores coordinate captures and marks the file origin. File-location prefixes use the shared execution
variable resolver; matcher regular expressions remain literal. Dispatch awaits a refreshed declarative extension catalog before matcher validation, so installation, grant and disable responses cannot race notification delivery. Each compilation
has its own readiness state.
Background tasks can run without a matcher, but dependency and Debug waits reject
them because no readiness event can be observed.

Task cwd is canonicalized beneath the authorized root by exec-server. CustomExecution
uses the Terminal's custom PTY path without allocating a backend shell. Host custom
PTY handles serialize open, input, resize, output and close; polling is bounded and
provider retirement releases the handle. Listeners are installed before execution
starts so the first output chunk reaches the problem collector.
An exit without a code records completion without inventing success or failure;
dependency and Debug waits require a successful result or background readiness.

Discovery ordering and catalog content versions are separate: a superseded dispatch
waits for current discovery and cannot use last-good data after a failed refresh.
Unchanged refreshes do not cancel pending execution. Configured `runOptions.instanceLimit`
sets the number of simultaneous instances (one by default). TaskService counts preparations
and published runs once, keeps capacity reserved through resource release, and permits
a new instance after completion. At capacity, `instancePolicy` defaults to a Quick Input choice of an instance to terminate.
`terminateOldest` and `terminateNewest` await the selected instance's resource release
before admitting a replacement; `warn` reports the limit and `silent` leaves existing
instances running. Concurrent decisions are serialized per task. Dependencies reuse
existing execution, and a canceled joiner or canceled picker cannot cancel its owner. Workspace changes, provider
retirement and service disposal still revoke its lifetime. Debug and Testing consume
`ITaskService` rather than starting another process runtime.

Tests live beside the parser and browser service. Changes to discovery must run
the workspace-task tests; changes to execution must also run the Terminal
service tests and the Code renderer build.

`fileLocation: "search"` resolves file suffixes through the existing Workspace file
search owner. A scalar searches the selected workspace folder. The array form
accepts ordered include directories and excluded subdirectories; paths resolve
through the same execution variables as the task. Included directories must belong
to the current workspace. Explicit objects with no include directories do not search.
Unmatched filenames retain the absolute fallback. Literal glob characters in paths
are quoted before reaching file search.

Problem collection preserves output order while resource lookups are pending.
Background readiness and foreground completion wait for those lookups. A new watch
cycle discards replies from the previous cycle. Cancellation aborts searches and
awaits their acknowledgment; lookup failure closes the terminal and rejects completion
after terminal release. Per-run collection and each lookup retain the existing 5,000
result bounds. Workspace owns directory traversal and ignore policy.

Enabled extensions' `contributes.configuration` declarations join the existing
ConfigurationRegistry. Tasks and Debug read their defaults and stored user values
through the shared configuration resolver. Catalog replacement validates the whole
contribution batch before committing; a failed replacement retains existing values
and other contributions. Withdrawal removes effective settings while preserving the
user's settings JSONC. Property schemas use the existing JSON schema validator;
workspace and folder configuration targets remain incomplete.

## Full VS Code compatibility target

| Contract area | Current behavior and remaining work |
| --- | --- |
| Environment | Shared host lookup, configured/provider overrides and nested variable resolution are implemented; inherited values retain the backend allowlist. |
| Task model and providers | TaskDefinition, process/shell/custom execution and dispatch-time resolveTask are implemented. Folder/Workspace scope, version/type filters, public execution handles, edits and copies of fetched CustomExecution and ordered start/end/process events are implemented. Empty-window execution, direct opaque callback invocation, presentation and automatic task execution remain incomplete; configured instance limits and all five capacity policies are supported. |
| Execution | Process argv, task cwd, structured shell quoting, explicit shell execution and custom PTY lifetimes are implemented. Platform overrides use the execution host OS; presentation policies remain incomplete; Windows shell behavior still needs host validation. |
| Orchestration and diagnostics | Dependency graphs, background readiness, bounded problem collection, contributed registries and scoped file-location search are implemented. History, persistent reconnection and automatic run policies remain incomplete. |

These remaining areas must be implemented and validated through the same owner before claiming the complete VS Code Tasks API or arbitrary task extension compatibility.

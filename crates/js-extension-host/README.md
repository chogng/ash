# Extension hosts

`ash-js-extension-host` executes ES modules authored with [`@ash/extension`](../../extension-sdk/README.md)
in an independent Rust process. It reuses the existing extension supervisor and bounded Host RPC,
so App Server remains free of the V8 dependency. Code Mode and this host share engine initialization
through `ash-v8-runtime`; execution state and permissions remain separate.

Standard `api: vscode` extensions run in the product's real Node runtime. The existing
App Server authority gate checks exact-package execution consent before its supervisor
launches Node directly with the packaged `extension-host/node.mjs` entry point. Node owns
CJS/ESM module loading, builtin modules, Buffer, filesystem, networking and child processes.
The host substitutes only `vscode` and the product SDK, using public synchronous Node module
hooks. Electron uses its frozen executable in Node mode; Web uses the packaged standalone Node.
No ambient PATH lookup selects the runtime. The supervisor retains process-group cleanup,
framed protocol quotas, cancellation, deadlines, recovery and authority revocation. This runtime
has user-level IO and does not claim the SDK host's confinement or whole-process resource limits.
Marketplace execution contract 5 requires fresh consent. Local Plugin authority retires only
legacy VS Code grants and persists that migration; SDK and other Plugin grants survive.
Developer environment inheritance excludes product authentication and inherited Electron controls.
The environment is frozen when the launcher is created; existing processes retain their copy.
An authenticated window can supply bounded `ExtensionHostStart.environment` overrides.
App Server removes product authentication keys from explicit overrides as well as inherited
values. The existing handshake applies the remaining mapping before any package evaluation;
strings replace values (including empty strings), null deletes a value and omitted keys inherit.
Node child processes inherit that window's resulting environment. Other windows keep their
own copies. Changing an already started window's environment requires a new connection-owned
fleet; ordinary crash recovery reuses its validated overrides and refreshes editor facts.

Standard Node extensions can await editor requests during `activate` and issue requests from
background listeners after a provider returns. The initiating authenticated window is bound by
App Server; lifecycle frames carry the exact incarnation and activation generation and cannot
select another connection. The existing supervisor services bounded concurrent calls while
activation is pending, acquires a live authority lease per call, and cancels and joins them before
releasing the process lease. A closed window retires its Node hosts and restores their activation
plans for the next window. SDK calls keep their narrower invocation boundary.
Extension exceptions and unhandled promises are recorded on captured stderr; malformed control
frames still stop the host. Node Host RPC uses a fresh authenticated loopback socket owned by
the existing process supervisor. Physical stdin/stdout remain ordinary Node streams, so raw
fd writes and Debug children inheriting stdout cannot corrupt control frames. The listener closes
after the exact child binding connects; startup is bounded, parent closure retires the host, and
termination shuts down the socket before joining readers. SDK and executable hosts retain stdio.

The product packages the V8 executable next to App Server. Plugin contributions explicitly select
`runtime: javascript`; an existing `hostRpc` contribution runs its own protocol program.
Installed extensions supply the admitted extension ID, absolute package root and relative JS entrypoint.
The product's `--builtin remote-ssh` entry instead loads its module and SDK compiled into the executable;
activation must match the release binding sent by App Server. It uses the same SDK and invocation
lifecycle, but product authority requires no workspace grant and permits no workspace file reads.
Installed packages cannot obtain this authority or register the reserved `ssh` prefix.
Only package-relative ESM imports and the product-provided SDK are available. Node, Electron,
filesystem, network, DOM and raw backend connections are absent from the JS context.

Each invocation binds SDK calls to its exact request, activation generation and process incarnation.
Rust only accepts the supported SDK operation subset. Editor snapshots and notifications go to the
initiating client; workspace reads are executed by App Server's authorized filesystem owner.
Command, hover, completion and document-event callbacks share the same invocation-bound SDK services. Provider snapshots retain
the editor's unsaved text; the SDK converts UTF-16 coordinates and the existing TS language bridge
validates and displays results. Callbacks cannot retain invocation authority after they return.
Invocation contexts expose a cancellation token and event. Caller cancellation revokes that invocation's
service authority and rejects pending child calls, then permits its callback to release resources and
finish within the supervisor's bounded grace period. Other callbacks retain their own authority.
Uncooperative callbacks, deadlines and activation-authority revocation retire the isolate; recovery
starts a fresh incarnation and never replays in-flight commands.

Module compilation failures are caught before they can print V8 diagnostics to protocol stdout.
The process reports the module name and compilation exception on stderr and exits; malformed
source cannot masquerade as a Host protocol frame.

The host bounds protocol payloads, concurrent calls, package sources, V8 heap and execution time.
On macOS, `ProductJavaScriptLauncher` selects the exact product executable and supplies separate
heap and backing-store budgets. After reading package sources and initializing V8, the child applies
a deny-by-default Seatbelt profile, permitting only sysctl reads and existing stdio pipes; no extension
code runs before confinement. Direct file access, networking and child processes are rejected.
The supervisor owns the process group and clears inherited environment state.

On 64-bit Windows, the launcher starts a restricted primary token in an AppContainer without
network capabilities and with a single-process kill-on-close job. Only the initial thread
receives temporary startup authority to read the package and initialize V8. Before any JS,
the child attests the launch restrictions, disables Win32k calls, lowers integrity and
permanently releases startup authority. Package read grants and the AppContainer profile
are owned by the process handle and removed after termination. The product install directory
is not modified; no administrator privileges or account provisioning are required.
Unsupported systems refuse installed-package execution. The immutable compiled product module
can run there with the same V8 budgets and deadlines, without loading external sources. Supported
systems also confine the product module. The trusted development launcher is for trusted tests.

The default JS budgets are 64 MiB heap and 64 MiB external fixed-length backing stores. Tiny inline
TypedArrays use the heap instead. The heap callback has a bounded 4 MiB termination allowance.
Cumulative backing-store exhaustion exits the extension process immediately, preventing V8 allocation
retries from growing the heap; the supervisor recovers without replaying the failed invocation.
Shared/resizable buffers and WebAssembly are unavailable because they bypass the per-isolate allocator.
The allocator delegates storage to V8's sandbox allocator; ordinary malloc is unsuitable.
These limits do not claim a whole-process OS memory cap. Independent executables retain their existing
whole-process resource requirements and cannot select JS isolation.
Open VSX scripts are not automatically executed by this host. On macOS and 64-bit Windows the separate Marketplace
execution policy admits exact installed packages after both enablement and execution consent.

The product Node host loads the standard package. Marketplace deployment selects its
`main` entry before `browser`; local Plugin declarations select their explicit entrypoint
with `runtime: javascript` and `api: vscode`, using the package-root `package.json`.
Automatic Task, Debug and status-bar observers are installed only within the authenticated
activation capability ceiling. A command-only package can activate without requesting those
unrelated providers; the supervisor still rejects registrations outside the declared ceiling.
Node supplies relative modules, JSON, package exports, directory entries, dependencies,
module metadata, `require.resolve` and its normal per-process module cache. The V8 `--api vscode`
mode remains an internal facade test harness; it does not provide Node capabilities and is not
the product route for standard extensions.
`require('vscode')` supplies an independently implemented public API subset: declared command registration,
notifications without buttons/options, single-select Quick Pick, read-only document snapshots, document
open/change/close events, diagnostic collections, Hover and completion providers with trigger characters.
`commands.executeCommand` uses the initiating client's existing CommandService.
JSON results preserve explicit null and falsy values; a void result becomes undefined.
Callback command requests are drained before callback retirement. Node activation and background
requests use the same client CommandService under the activation's lifetime.
Non-JSON command values and URI-rich results remain incomplete.

Task providers expose `Task`, `TaskGroup`, `TaskScope`, `ProcessExecution`,
`ShellExecution` and `CustomExecution`. Both ShellExecution overloads retain shell options;
structured arguments and ShellQuoting reach the Workbench task owner, which quotes them
after variable resolution. Discovery and `resolveTask` are distinct callbacks. Build, Test, Clean and Rebuild groups
and the optional default flag survive task snapshots; presentation/run options default
to empty objects. `TaskPanelKind`, `TaskRevealKind` and `presentationOptions` map echo, showReuseMessage, panel, clear,
reveal, focus and close to the Workbench execution owner, including query/resolve
round trips and edited fetched process, shell or custom Tasks. Command echo defaults to true
at execution and remains separate from problem matcher output. `showReuseMessage`
survives round trips and controls the completed terminal's reuse notice. `runOptions.reevaluateOnRerun` survives provider resolution, task queries
and execution events. Rerun Last Task uses the canonical execution owner to retain variable
values when false; ordinary executeTask resolves variables again.
`tasks.fetchTasks` applies type/version filters, and `tasks.executeTask` runs a fetched catalog
task or a constructed shell/process/custom Task through the same Workbench owner. Stable TaskExecution handles expose terminate and the
synchronous taskExecutions list; the four task/process start/end events retain listener receivers.
Ordered snapshots and completion fences prevent late replies from restoring completed executions.
Explicit Tasks keep their originating object in events and execution handles, and retire with
their extension incarnation. Editing a fetched Task retains its configuration-only
`revealProblems` policy across repeated explicit executions; that policy is not a
public `TaskPresentationOptions` property and newly constructed Tasks do not inherit it.
Custom Tasks reuse the bounded PTY owner and await release acknowledgment.
Metadata edits to a fetched CustomExecution select the current catalog's callback;
the callback and PTY stay with the original provider incarnation while the explicit
run belongs to the caller incarnation. Repeated edits retain the caller's Task object.
Copying an opaque fetched execution to a new Task retains its catalog callback
identity while dispatching the new Task's metadata. Provenance belongs to the
execution object and is not exposed as a public handle. Prototype-only copies are
rejected. Replacing it with a caller-owned callback uses ordinary explicit dispatch.
Direct invocation of an opaque fetched execution's callback remains unsupported.
Custom PTYs keep bounded output queues; terminal close or incarnation retirement releases
their listeners and handles. Input and dimensions return to the same handle.
`EventEmitter` supplies the public callback primitive. `CancellationTokenSource` exposes independent
tokens; Tasks, Debug configuration, hover and completion callbacks receive a live token bound to
their own invocation, including cancellable event listeners and late-listener delivery. Debug configuration
providers retain undefined cancellation and null configuration opening as distinct results
in both resolution phases. Declared debugger types can
register executable descriptors with literal argv and child cwd/env, `DebugAdapterServer`,
`DebugAdapterNamedPipeServer` and `DebugAdapterInlineImplementation`.
Descriptor callbacks receive the prepared DebugSession with its stable ID and canonical
workspace folder; the same public handle is used by later session events. Descriptor factories receive the declared default executable as their second standard API
argument. The Workbench registry retains the declarative default independently of the dynamic
factory owner; unregistering that factory reveals the default. A debugger type may omit executable
metadata when its factory supplies the descriptor.

`debug.asDebugSourceUri` returns file URIs or session-bound debug URIs; reference-backed sources use the Workbench content provider and its existing model reference owner. `activeStackItem` and its change event expose DebugThread/DebugStackFrame handles with the same DebugSession identity; selection, resume and stop follow the Workbench owners. DebugConfigurationProvider callbacks provide Initial templates and
resolve configurations before and after variable substitution, with canonical workspace
folder metadata. Dynamic configurations appear in Select and Start Debugging and launch
without being saved to launch.json. A dormant type remains discoverable before its
factory activates. Server/pipe descriptors use the existing Rust transport owner;
inline descriptors retain the implementation in the extension process and route bounded messages through
the same TypeScript DAP session. Inline listeners and implementations are released once,
including factory disposal and host deactivation; normal close preserves unrelated callbacks.
`Uri`, `Position`, `Range`, `Location`, `SourceBreakpoint`, `FunctionBreakpoint`, `Hover`, `MarkdownString`, `Diagnostic`, `CompletionItem`, `CompletionList`,
`TextEdit`, `SnippetString` and `Disposable` implement the members used by these calls.
Node builtins and package `exports` conditions come from Node. The full ExtensionContext
remains incomplete. Completion resolving, command-bearing
items, insert/replace ranges, advanced diagnostic tags/related information and some item kinds are unsupported.
Activation receives the existing lifetime-owned `subscriptions`, the captured package
`extensionUri`/`extensionPath`, `asAbsolutePath`, production mode and its own Extension
metadata. Its activation promise and exported API keep their identity; exports become
available after activation completes. `Uri.joinPath` resolves resource paths while
preserving URI query and fragment. Persistent mementos, storage directories, secrets
and environment-variable collections remain ExtensionContext gaps.
Service calls require an active command, provider or document-event
callback. Missing module/API accesses fail explicitly.

Document listeners receive stable document objects that update with ordered model events; providers receive
immutable snapshots. The document list is populated by event delivery after activation or explicit document
reads, so it is not a complete initial document list during activation. Collections capture the version read
by their invocation, even when a newer event arrives during an await. Workbench owns marker storage, isolates
collection names by broker-supplied extension identity and removes markers when an incarnation retires.
Tasks and executable Debug descriptors use Marketplace's execution-consent contract version 5; previous consent
requires enablement and authorization under the new contract.

V8 continuation-preserved embedder data and Node AsyncLocalStorage respectively bind each
async callback to its original invocation. The host
checks that identity on every client request; expired continuations cannot borrow a later invocation.
Ignored notification Thenables are drained before the callback retires. The V8 test harness passes extension source as a quoted function body;
standard extensions use the real Node loader.
Package bytes remain unchanged; installation and execution consent use separate owners.

App Server schedules Open VSX startup in Rust. An enabled and authorized package waits without a
process or incarnation until `onCommand`, `onLanguage` or `onStartupFinished` matches. Declared
commands and languages imply their activation events even when `activationEvents` is absent.
For standard extensions, `*` starts when the first window supplies its initialization facts;
`onStartupFinished` waits until the editor window is restored.
Other activation event types are not implemented. Manifest command titles are available in the
command palette while waiting, but callbacks and providers appear only after the runtime handshake.
Health polling never starts a waiting package. The activation request checks the exact package
generation and current authority, and concurrent requests cannot start two incarnations. Local SDK
and independent executable extensions retain their existing startup behavior.

Run `just check ash-js-extension-host`, `just test ash-js-extension-host` and
`just rust-warnings ash-js-extension-host`. Process tests exercise the embedded SDK, package module
imports, editor versus disk content, hover capability admission and snapshot coordinates, errors,
revoked authority, deadlines, cancellation and cleanup.


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
breakpoint events update those bindings without rewriting the user's source position.
Standard adapter tracker factories support type selectors, `*`, asynchronous
creation, the prepared session object and all six lifecycle/message hooks.
Callbacks retain their receiver and invocation ownership. Factory disposal stops
new creation while active tracker handles survive until exit or explicit cleanup.
Executable, server, pipe and inline adapters use the same session owner. Parent
lifecycle, console sharing and noDebug options are implemented; the remaining
session options are compatibility gaps.

The executable descriptor callback receives the prepared session's stable ID and
canonical workspace-folder metadata. DebugAdapterSession is created before the
factory callback; the same ID is used by later custom/start/end events. Its public
identity is independent of the backend process handle. A failed factory retires the
prepared session without spawning a process. The source configuration remains
available for restart; extension inspection uses the resolved launch snapshot.

Standard Debug descriptor factories accept `undefined` and `null` as an empty
result. That result reaches the existing Debug owner as JSON `null`; it prevents
adapter startup and preserves the extension host for following invocations.

The Workbench supplies an initialization snapshot on first use: current workspace folders,
workspace name/file, UI language, effective configuration values and configuration models. App Server
validates the snapshot before activation and binds it to the selected activation generation.
Node recovery refreshes facts from that same window. Package evaluation begins after
this binding, so top-level CommonJS code and `activate` can synchronously read
`workspace.workspaceFolders`, `getWorkspaceFolder` and `getConfiguration` (`get`, `has`,
`inspect`, including language overrides). The frontend configuration service remains the owner;
the facade receives live snapshots through the `workspaceEvents` registration. Configuration
and workspace changes use separate ordered, bounded queues in MainThreadConfiguration and
MainThreadWorkspace; both retire on incarnation/generation changes and keep the frontend owners.
Public change events update synchronous reads before firing. Configuration objects retain their
creation snapshots, scoped `affectsConfiguration` compares effective values including policy and
language overrides, and surviving workspace folders retain their handles when name/index change.
Each supervised Node incarnation queries the bound window again before package evaluation,
including crash recovery. Configuration mutation and full ExtensionContext remain incomplete.

The standard Node host loads the manifest's `l10n` directory for that window language before
evaluating the extension. `env.language` comes from the Workbench NLS owner. `l10n.t` supports
indexed/named replacements and translation comments; `bundle` and `uri` describe the actual
loaded package resource. Missing or invalid resources use the source message, without an
invented bundle. Other `env` APIs and built-in Language Pack bundle resolution remain incomplete.

# Rust V8 extension host

`ash-js-extension-host` executes ES modules authored with [`@ash/extension`](../../app-ts/extension-sdk/README.md)
in an independent Rust process. It reuses the existing extension supervisor and bounded Host RPC,
so App Server remains free of the V8 dependency. Code Mode and this host share engine initialization
through `ash-v8-runtime`; execution state and permissions remain separate.

The product packages the executable next to App Server. Plugin contributions explicitly select
`runtime: javascript`; an existing `hostRpc` contribution runs its own protocol program.
The JS host receives the admitted extension ID, absolute package root and relative JS entrypoint.
Only package-relative ESM imports and the product-provided SDK are available. Node, Electron,
filesystem, network, DOM and raw backend connections are absent from the JS context.

Each invocation binds SDK calls to its exact request, activation generation and process incarnation.
Rust only accepts the supported SDK operation subset. Editor snapshots and notifications go to the
initiating client; workspace reads are executed by App Server's authorized filesystem owner.
Command, hover, completion and document-event callbacks share the same invocation-bound SDK services. Provider snapshots retain
the editor's unsaved text; the SDK converts UTF-16 coordinates and the existing TS language bridge
validates and displays results. Callbacks cannot retain invocation authority after they return. Cancellation retires the entire
isolate; recovery starts a fresh incarnation and never replays in-flight commands.

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
Unsupported systems refuse production execution. The trusted development launcher is for trusted tests.

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

The `--api vscode` mode loads a standard CommonJS bundle, preferring its `browser` entry over `main`.
`require('vscode')` supplies an independently implemented public API subset: declared command registration,
notifications without buttons/options, single-select Quick Pick, read-only document snapshots, document
open/change/close events, diagnostic collections, Hover and completion providers with trigger characters.
`Uri`, `Position`, `Range`, `Hover`, `MarkdownString`, `Diagnostic`, `CompletionItem`, `CompletionList`,
`TextEdit`, `SnippetString` and `Disposable` implement the members used by these calls. Relative CommonJS
imports, Node modules and the full ExtensionContext are unsupported. Completion resolving, command-bearing
items, insert/replace ranges, advanced diagnostic tags/related information and some item kinds are unsupported.
Activation receives `subscriptions`; service calls require an active command, provider or document-event
callback. Missing module/API accesses fail explicitly.

Document listeners receive stable document objects that update with ordered model events; providers receive
immutable snapshots. The document list is populated by event delivery after activation or explicit document
reads, so it is not a complete initial document list during activation. Collections capture the version read
by their invocation, even when a newer event arrives during an await. Workbench owns marker storage, isolates
collection names by broker-supplied extension identity and removes markers when an incarnation retires.
Expanding the window operations increments Marketplace's execution-consent contract; previous consent
requires enablement and authorization under the new contract.

V8 continuation-preserved embedder data binds each async callback to its original invocation. The host
checks that identity on every client request; expired continuations cannot borrow a later invocation.
Ignored notification Thenables are drained before the callback retires. The original extension source is
passed as a quoted function body, preventing bundle text from escaping the trusted module wrapper.
Package bytes remain unchanged; installation and execution consent use separate owners.

App Server schedules Open VSX startup in Rust. An enabled and authorized package waits without a
process or incarnation until `onCommand`, `onLanguage` or `onStartupFinished` matches. Declared
commands and languages imply their activation events even when `activationEvents` is absent.
`*` starts immediately; `onStartupFinished` is sent only after the editor window is restored.
Other activation event types are not implemented. Manifest command titles are available in the
command palette while waiting, but callbacks and providers appear only after the V8 handshake.
Health polling never starts a waiting package. The activation request checks the exact package
generation and current authority, and concurrent requests cannot start two incarnations. Local SDK
and independent executable extensions retain their existing startup behavior.

Run `just check ash-js-extension-host`, `just test ash-js-extension-host` and
`just rust-warnings ash-js-extension-host`. Process tests exercise the embedded SDK, package module
imports, editor versus disk content, hover capability admission and snapshot coordinates, errors,
revoked authority, deadlines, cancellation and cleanup.

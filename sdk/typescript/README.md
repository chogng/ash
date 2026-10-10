# Ash TypeScript extension SDK

This README describes the TypeScript author SDK under root `sdk/typescript`, alongside the Rust SDK in `sdk/rust`. Ash supports both TS/JS and independent Rust extensions: Desktop targets Electron reuse, and the backend targets Rust/V8 without a standalone Node dependency. This move preserves the existing SDK API and runtime behavior; compatibility migration remains separate work. VS Code/Node compatibility and engine execution belong to the product runtime, not the author SDK, and existing VS Code extensions do not have to adopt this SDK. The agreed boundaries are maintained in [the extension architecture](../../docs/editor-extensions.md#共享接入与语言适配的-crate-边界).

Backend authors import `@ash/extension`, export `activate`, and compile their entry to an ES module.
A Rust V8 host executes the JavaScript without Node. Editor operations use the initiating
client; `readTextFile` uses the Rust filesystem service and its current directory grant.
The cross-layer direction and installation boundary are documented in
[`docs/editor-extensions.md`](../../docs/editor-extensions.md).

Trusted browser packages import `@ash/extension/browser` and export the `activate` and
`deactivate` functions returned by `defineBrowserExtension`. This entry bundles with the
package and joins the same SDK registration, invocation, cancellation and disposal lifecycle
to the product Worker bridge. It provides command metadata and originating-editor references,
snapshot language providers, custom text editor content and disposable Webview resources.
Language positions use the shared SDK's zero-based UTF-16 `line`/`character` convention.

Each browser callback receives invocation-scoped document, configuration, directory and command
services. The window owns unsaved text, authorization, undo and persistence. Workspace folders
include only roots currently accessible to its file services, so Markdown continues to work
without a backend connection. Retaining a callback context does not extend service authority.
Disposal revokes callbacks; cancellation stops their child requests. Webview resources are
created during activation, released explicitly or when the Worker retires, and never copied
into document edit messages. Extension refresh cancels callbacks and runs SDK deactivation
before replacing the Worker, with a one-second cleanup deadline. Window disposal and Worker
failure terminate it directly; the window still releases all tracked Webview resources.
The existing trusted-package boundary remains in effect; this
entry does not enable browser execution of Marketplace packages or add custom editors to V8.
The private Worker messages are SDK/host adapters, not an author API.

Run `pnpm --dir sdk/typescript test` for browser SDK contract and lifecycle tests.

API v1 supports commands, hover and completion providers, ordered document events, diagnostics, immutable editor document snapshots, bounded UTF-8 workspace file
reads, notifications, Quick Pick, Task providers, Debug configuration providers, executable/server/pipe descriptors and adapter tracker factories. Register commands and providers during activation and put their disposables
in `context.subscriptions`. Each callback receives a context bound to its own invocation; do not retain
it for background calls after the command returns. Command IDs and callback JSON results are bounded
by the shared host protocol. Disposing a registration revokes new callbacks; tracker factories retain hooks owned by active sessions.
The activation's advertised registration set is replaced when the host deactivates or restarts.

`tasks.registerTaskProvider(id, type, provider)` advertises `taskProvider` and supports
`provideTasks` plus dispatch-time `resolveTask`. Descriptors contain process argv, shell
command lines or structured quoted arguments, optional shell executable/arguments/quoting,
cwd, env, definitions, background state and matchers. Groups preserve build, test, clean and
rebuild identity plus the optional `groupIsDefault` flag in discovery, resolution and events.
Environment values may be strings
or null removals. Custom descriptors
reference `createTaskTerminal` callbacks: the host owns opaque PTY handles and bounded
event queues; the Terminal owns rendering, input and task state. Open, read, input,
resize and close are invocation-bound operations. Provider disposal releases every
PTY even if one disposer fails. Declare `taskProvider` capability.

`debug.registerDebugAdapterDescriptorFactory(id, type, factory)` advertises `debugAdapter`.
Callbacks return an executable program, literal arguments and optional cwd/env,
or `{ connection: { type: 'server', port, host? } }` / `{ connection: { type: 'namedPipe', path } }`.
Connected descriptors cannot include executable options. The existing Debug transport
owner validates and launches or connects; the extension receives no raw socket.
Inline callbacks return `{ implementation }` with `onDidSendMessage`,
`handleMessage(context, message)` and `dispose(context?)`. The SDK owns up to eight
opaque handles, snapshots messages at emission and bounds their queue to 512 messages
and 256 KiB. Send/read/close remain finite invocation-bound operations; DebugAdapterSession
owns protocol state and awaits listener/implementation cleanup before ending the session.
Factory disposal retains handles already in use, and deactivation releases every handle.
The cleanup context is present for explicit session close; deactivation provides no service
authority. Declare `debugAdapter` capability. Node modules remain unavailable.

`debug.registerDebugAdapterTrackerFactory(id, type, factory)` advertises
`debugAdapterTracker` under the same capability. `*` observes all adapter types;
multiple factories may register the same type. An asynchronous factory receives the
prepared session snapshot and returns optional lifecycle/message hooks. Every hook
receives its own invocation context before its public arguments. Factory disposal
stops new creation and keeps existing tracker handles until exit or cleanup. Sending
waits for `onWillReceiveMessage`; ordered `onDidSendMessage` delivery leaves the DAP
reader free for callback custom requests. The receive queue permits 2,048 pending
messages; overflow stops message observation and reports an error. Stop precedes
process close; exit follows acknowledgement and preserves unknown code/signal.
All factories share a one-second creation deadline; late handles are released.

`debug.registerDebugConfigurationProvider(id, type, provider, triggerKind?)` advertises
`debugConfigurationProvider` under the same `debugAdapter` capability. Optional callbacks
provide initial templates or resolve configuration before/after variable substitution.
Folder metadata contains the canonical URI, name and index. Initial (1) templates create
launch.json; Dynamic (2) configurations appear in Select and Start Debugging without
being saved to launch.json. Both kinds resolve launches. Undefined cancels startup; null
also opens the selected workspace folder's launch.json. The Host result envelope preserves
the distinction in both phases. The Debug owner validates results and cancels pending
callbacks when the registration retires.

There is no `require`, `process`, Node module access, direct filesystem/network access, Electron,
DOM, arbitrary command execution or raw App Server connection. Node-dependent packages require
adaptation. This is a supported API subset, not full VS Code compatibility. Relative ESM imports
stay inside the admitted package; the product supplies the SDK module.

Run `pnpm --dir sdk/typescript typecheck` or `pnpm --dir sdk/typescript build:example`.
The latter emits `.build/sdk/typescript/example/extension.js` and `.build/sdk/typescript/.ash-plugin/plugin.json`.
The manifest uses `runtime: javascript`, API version 1 and a `directory: read` permission.
Granting that package does not replace the workspace's `ReadFiles` authorization.
The SDK is currently repository-local; use a local package dependency and leave `@ash/extension`
external when bundling backend packages. Browser packages bundle `@ash/extension/browser` and
its shared SDK module once, as illustrated by `extensions/markdown-language-features`.
`ExtensionError.code` preserves Rust service failure categories.
Activation registers contributions without service calls; top-level module initialization and deactivation
must finish without waiting for external services. Dynamic import and CommonJS are unsupported.

`languages.registerHoverProvider(id, languageIds, provider)` uses the existing editor language bridge.
Declare `languageProvider` in the manifest capabilities. `provideHover(call, document, position)` receives
the initiating editor's immutable text and version, including unsaved changes. Its URI can be absent
for an editor without a resource. Positions and ranges use zero-based `line` and UTF-16 `character`;
the SDK converts them to the transport format and rejects positions outside the snapshot or reversed ranges.
Return `undefined` for no result, or `{ contents, range? }` with text or language-tagged code blocks.
The editor owns rendering and accessible hover controls. Disposal rejects new calls to the provider;
each invocation exposes `call.cancellationToken`, with an event and a current cancellation flag.
A cooperative callback can release its local resources and return after cancellation while other calls
keep running in the same isolate. Cancelled calls lose service authority immediately, including queued
child requests. Ignoring cancellation, exceeding a deadline, or losing activation authority retires the
isolate; recovery creates a fresh instance.

`languages.registerCompletionProvider(id, languageIds, provider, triggerCharacters?)` receives the same
immutable document snapshot and UTF-16 position, plus the invocation, trigger-character or incomplete-refresh
context. Return `{ isIncomplete, items }`; item ranges use `line`/`character`, and insertion text can be plain
text or a snippet. The existing editor suggestion list owns filtering, display and insertion.

`workspace.registerRemoteConnectionResolver(prefix, resolver)` requires the `remoteAuthorityResolver`
manifest capability and runs during activation. This is Ash’s saved-connection API; the manifest
capability keeps its existing name; registrations use `remoteConnectionResolver` and invoke `resolveConnection`. Its `resolve(call, authority)` callback returns
`{ connectionName }`, referencing an existing saved connection. The `ssh` prefix belongs to the
built-in `extensions/remote-ssh` package. Both it and installable SDK extensions execute
through the Rust V8 host and this SDK. Contributed prefixes are lowercase letters, digits and hyphens,
start with a letter, and contain at most 64 characters. A connection intent uses `prefix+target`.
This is distinct from an opened workspace's `ash-remote://ssh+host/path` identity.
Duplicate prefixes reject the entire replacement rather than selecting a handler by load order.

`call.workspace.openRemoteConnection(authority)` resolves the target and asks the initiating
window to confirm the extension identity, SSH host and folder before opening a new window.
The host rereads the saved catalog and rejects a target changed after confirmation. Cancellation,
disconnect, stop and restart invalidate pending resolution; an accepted window belongs to the
connection host and survives the initiating callback. Extensions receive neither SSH options,
credentials, sockets nor permission to spawn processes. The example command connects through
`saved+build`; first save a connection named `build` through Remote connection management.

The saved selector supports SSH targets. Separately, the SDK provides the endpoint resolver contract described below. It does not implement VS Code's full proposed resolver API,
a remote extension-host placement policy, or inbound Tunnels hosting. The built-in SSH package
is compiled into the product host and starts without a workspace grant or workspace file access.
Installed packages retain their workspace authorization and platform isolation requirements; they
cannot request the internal product authority that admits the reserved `ssh` registration.

`workspace.registerTextDocumentEvents(id, listener)` requires `languageProvider`. After activation the
window sends open events for existing models, then ordered open/change/close events. Change ranges and
offsets are UTF-16 and refer to the previous text; the accompanying snapshot contains the committed version.
Language changes close the old document and open the new language. Callbacks can await invocation-scoped
services. The connection retains at most 64 pending events per subscription; exceeding that limit stops
the subscription and reports an error, rather than skipping edits. A new incarnation receives fresh open events.

`window.registerStatusBar(id, snapshot)` requires `statusBar` capability. Register during activation;
the snapshot callback returns `{ revision, entries }` without keeping historical command arguments.
`call.window.setStatusBarEntries(id, revision, entries)` replaces all visible entries for that registration.
Each entry contains `id`, `text`, nullable `tooltip` and `ariaLabel`, `alignment` (`left` or `right`), finite
`priority`, and a nullable `{ command, arguments }` command. Arguments are JSON values. Revisions are
positive safe integers and increase monotonically; stale updates are ignored. Empty entries hide all
items, and disconnect, stop or restart release their accessors. The workbench executes clicks through its
existing command service. Keep the registration in `context.subscriptions`.

`call.languages.setDiagnostics(collection, entries)` replaces the entire named collection for that
extension incarnation; `[]` clears it. Each entry has a URI, observed document version (or null for an
unread resource) and diagnostics with zero-based UTF-16 start/end, severity, message, nullable source and code.
A replacement containing an outdated document version is ignored. Collections allow 1,024 resources,
10,000 total markers and 128 collection names per extension. Disconnect, stop and restart remove their markers.

The example exercises current editor text,
Rust disk reads, notification and a plaintext hover, so unsaved editor text is not mistaken for disk content.
On macOS, use the command palette **Install extension from workspace**, enter `.build/sdk/typescript`
relative to the selected authorized directory, then use **Manage local extensions** to enable the
package and grant its declared permissions separately. Installation records the exact digest and
never enables or grants the package. Changes persist across restart; revoke, disable and uninstall
retire running callbacks. A revision conflict requires reopening management with the latest state.

On macOS, the product JS process applies Seatbelt before extension code runs. It denies direct file access,
networking and child processes. Each instance has a 64 MiB V8 heap budget (with a bounded 4 MiB
termination allowance) and a separate 64 MiB budget for external fixed-length ArrayBuffers. Small
inline TypedArrays count against the heap. Cumulative external-buffer exhaustion retires the process;
recovery creates a fresh authorized instance. Shared/resizable buffers and WebAssembly are unavailable.
These are JavaScript storage budgets, not a whole-process OS memory limit. Installed packages require
OS confinement on macOS or 64-bit Windows. The immutable compiled SSH module also runs on other
systems with the same V8 budgets and execution deadlines; it cannot load external package code. Compatible Open VSX bundles have separate explicit execution
consent, documented in [the extension system](../../docs/editor-extensions.md#06-已支持的-vs-code-javascript-接口).
Independent executables do not gain JS admission. The trusted development launcher remains for explicitly trusted local verification.

A Debug descriptor factory may return `undefined` or `null`; the SDK encodes either
as JSON `null`. The Debug owner rejects startup without falling back to a package
executable, and releases the prepared session.

`workspace.registerRemoteAuthorityResolver(prefix, resolver)` registers a standard endpoint resolver.
Its `resolve(authority, { resolveAttempt })` returns `new ResolvedAuthority(host, port, connectionToken)`
or `new ManagedResolvedAuthority(makeConnection, connectionToken)`. This uses the same manifest capability,
but a separate `remoteAuthorityResolver` registration and `resolveAuthority` invocation. The reserved
`ssh` prefix remains with the saved selector.

A Desktop window requested by `call.workspace.openRemoteConnection(authority)` starts a local extension
control connection first, resolves the endpoint there, then initializes its remote App Server connection
before starting Workbench services. The local V8 host remains available for managed connections and local
extension calls. Each retry resolves again with a new attempt. Managed factories and sockets belong to the
trusted local backend connection; replacing an address, closing that connection, or retiring its extension
releases its resources without closing another window's sockets. Each owner may have four sockets, with
1 MiB receive/write buffering per socket; the host caps managed factories and sockets at 128 each.

`RemoteAuthorityResolverError.NotAvailable(message, handled)` and `.TemporarilyNotAvailable(message)`
preserve their categories. A WebSocket endpoint speaks Ash's authenticated `/ash/app-server` JSON protocol;
the token becomes the `ash-session` subprotocol. A managed factory supplies already authorized message
passing and transports JSONL bytes; no Node/network capability is added to the V8 sandbox. A managed token
is retained in connection data; the factory remains responsible for its carrier authentication.

Resolvers may implement `getCanonicalURI(uri)`, receiving an immutable `Uri` with decoded components,
`with`, `toString` and `toJSON`. Return a `Uri`, or `null`/`undefined` to retain the input identity; omitting
the callback also retains identity. Desktop deduplicates queries per URI. Re-resolution, provider
replacement, extension retirement and window disposal invalidate cached identities and pending queries.
Workspace trust reads canonical remote folder paths on the same host; a canonical result cannot redirect
directory authorization to another host or the local filesystem. Rust remains the directory-grant owner.

Attach `ResolvedOptions` directly to the returned authority (for example with `Object.assign`). The
platform resolver stores `extensionHostEnv`, `isTrusted` and the `{ id, providerId }` reference derived
from `authenticationSessionForInitializingExtensions`. Access tokens, account details and scopes are
not sent to the platform cache. Environment entries accept strings or `null` (removal), with at most
128 entries, 128-character names and 8,192-character values. A negative trust hint restricts the UI
trust view; a positive hint cannot grant directory capabilities. Empty remote windows can show a
resolver-provided trust state after checking the canonical remote namespace still identifies that host;
this never reads or grants the filesystem root. Desktop applies environment overrides before loading
remote JS extension modules, exposing explicit values through `process.env`. Null entries remove values;
the confined runtime inherits no shared backend environment and exposes no other Node process APIs.
Each remote connection owns separate extension processes, reapplies options on reconnect, and stops
those processes on close. The local resolver stays in the local host. Execution still requires packages
installed, enabled and granted on the remote backend, plus applicable directory discovery permissions.
Authentication references remain metadata: account-based extension synchronization and automatic
installation are not implemented.

This slice does not provide recursive `ExecServer`, remote extension-host deployment,
or VS Code Server wire compatibility. Web keeps its existing
launcher-authenticated connection flow. Inbound Tunnels hosting still needs a separate implementation.

Granted local JS packages declaring `remoteAuthorityResolver` execute at profile scope so an empty remote window can resolve its endpoint. Other executables keep their workspace discovery gate. This does not grant disk or network access: every file read still requires the invoking connection's current directory authorization.

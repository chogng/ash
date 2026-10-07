# Ash TypeScript extension SDK

Authors import `@ash/extension`, export `activate`, and compile their entry to an ES module.
A Rust V8 host executes the JavaScript without Node. Editor operations use the initiating
client; `readTextFile` uses the Rust filesystem service and its current directory grant.
The cross-layer direction and installation boundary are documented in
[`docs/editor-extensions.md`](../docs/editor-extensions.md).

API v1 supports commands, hover and completion providers, ordered document events, diagnostics, immutable editor document snapshots, bounded UTF-8 workspace file
reads, notifications and Quick Pick. Register commands and providers during activation and put their disposables
in `context.subscriptions`. Each callback receives a context bound to its own invocation; do not retain
it for background calls after the command returns. Command IDs and callback JSON results are bounded
by the shared host protocol. Disposing a registration immediately makes its callback unavailable;
the activation's advertised registration set is replaced when the host deactivates or restarts.

There is no `require`, `process`, Node module access, direct filesystem/network access, Electron,
DOM, arbitrary command execution or raw App Server connection. Node-dependent packages require
adaptation. This is a supported API subset, not full VS Code compatibility. Relative ESM imports
stay inside the admitted package; the product supplies the SDK module.

Run `pnpm --dir extension-sdk typecheck` or `pnpm --dir extension-sdk build:example`.
The latter emits `.build/extension-sdk/example/extension.js` and `.build/extension-sdk/.ash-plugin/plugin.json`.
The manifest uses `runtime: javascript`, API version 1 and a `directory: read` permission.
Granting that package does not replace the workspace's `ReadFiles` authorization.
The SDK is currently repository-local; use a local package dependency and leave `@ash/extension`
external when bundling. Do not ship another copy of the runtime module in the extension bundle.
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
cancelling an invocation retires the entire extension isolate and recovery creates a fresh instance.

`languages.registerCompletionProvider(id, languageIds, provider, triggerCharacters?)` receives the same
immutable document snapshot and UTF-16 position, plus the invocation, trigger-character or incomplete-refresh
context. Return `{ isIncomplete, items }`; item ranges use `line`/`character`, and insertion text can be plain
text or a snippet. The existing editor suggestion list owns filtering, display and insertion.

`workspace.registerTextDocumentEvents(id, listener)` requires `languageProvider`. After activation the
window sends open events for existing models, then ordered open/change/close events. Change ranges and
offsets are UTF-16 and refer to the previous text; the accompanying snapshot contains the committed version.
Language changes close the old document and open the new language. Callbacks can await invocation-scoped
services. The connection retains at most 64 pending events per subscription; exceeding that limit stops
the subscription and reports an error, rather than skipping edits. A new incarnation receives fresh open events.

`call.languages.setDiagnostics(collection, entries)` replaces the entire named collection for that
extension incarnation; `[]` clears it. Each entry has a URI, observed document version (or null for an
unread resource) and diagnostics with zero-based UTF-16 start/end, severity, message, nullable source and code.
A replacement containing an outdated document version is ignored. Collections allow 1,024 resources,
10,000 total markers and 128 collection names per extension. Disconnect, stop and restart remove their markers.

The example exercises current editor text,
Rust disk reads, notification and a plaintext hover, so unsaved editor text is not mistaken for disk content.
On macOS, use the command palette **Install extension from workspace**, enter `.build/extension-sdk`
relative to the selected authorized directory, then use **Manage local extensions** to enable the
package and grant its declared permissions separately. Installation records the exact digest and
never enables or grants the package. Changes persist across restart; revoke, disable and uninstall
retire running callbacks. A revision conflict requires reopening management with the latest state.

The product JS process applies Seatbelt before extension code runs. It denies direct file access,
networking and child processes. Each instance has a 64 MiB V8 heap budget (with a bounded 4 MiB
termination allowance) and a separate 64 MiB budget for external fixed-length ArrayBuffers. Small
inline TypedArrays count against the heap. Cumulative external-buffer exhaustion retires the process;
recovery creates a fresh authorized instance. Shared/resizable buffers and WebAssembly are unavailable.
These are JavaScript storage budgets, not a whole-process OS memory limit. Other operating systems
currently refuse product JS execution. Compatible Open VSX bundles have separate explicit execution
consent, documented in [the extension system](../docs/editor-extensions.md#06-已支持的-vs-code-javascript-接口).
Independent executables do not gain JS admission. The trusted development launcher remains for explicitly trusted local verification.

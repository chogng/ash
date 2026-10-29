# @ash/sdk

Ash's public TypeScript extension API. This package contains self-contained types and
a host-only module entry; no Ash checkout, Rust toolchain or `@types/ash` is needed to
compile a TypeScript extension. The admitted Ash host supplies the runtime implementation
for this exact extension. Importing the package in an ordinary Node process does not grant
access to Ash services.

New SDK capabilities follow the [capability opening principles](../../docs/editor-extensions.md#sdk-能力开放原则): start with a concrete need in an existing extension, reuse the owning host service, and expose only the operations needed for that scenario. Unsupported API lists and differences between language bindings are not implementation queues; validate additions through the consuming extension.

## Extension development

Choose the package's execution host and verify its admitted capabilities before
implementing a feature. Public types describe the author contract; they do not
grant execution or imply that every host implements every operation. Ordinary
TS/JS packages, trusted Browser extensions and admitted Rust editor clients have
different entrypoints. The editor-client `ash:editor/*` modules are not an alternate
API for an ordinary `@ash/sdk` extension.

Keep optional feature logic, feature-specific views, styles, instructions and
translations in the extension package. A feature needing a native window, drag
operation or OS permission can still own its UI. The host owns the privileged
mechanism, trusted resource selection and authoritative permission check, exposed
through the smallest supported capability. Use public SDK types and declared
dependencies; do not import private Ash source or styles, including through
type-only imports or filesystem links.

For supported isolated views, pass explicit serializable data and semantic theme
values through their documented contract. The view does not inherit the extension
host's services or authority. Localize visible text and accessible names, provide
a keyboard alternative to pointer-only interactions, and distinguish an operation
request from its completed result. Opening settings, copying a path or starting a
drag does not mean access was granted. Dispose view resources when the interaction
ends and invalidate outstanding work when its Provider registration is retired.

Compile and package the view's assets with the extension. Verify the resources
actually loaded by the target host, not only the source files in the checkout.
Exercise the consuming extension through registration, invocation and disposal;
for new privileged operations also verify denial and cancellation. When testing
with substituted OS actions, report which native behavior remains untested.

## Declarative keymaps

A package can contribute `keybindings` without a JavaScript entry point. Each entry
declares `command`, `key`, optional `mac`/`linux`/`win` overrides, an optional `when`
expression and JSON `args`. An empty platform override disables that binding on
that platform. Bindings use the client keyboard platform, respect user overrides,
and are removed when the package is disabled, uninstalled or its host is disposed.
Non-built-in packages currently admit the eight selection and line-editing actions in
the optional keymap below, without arguments. General Workbench commands and
argument-bearing bindings are excluded from external declarative assets. Built-in
bindings retain their host-owned command contract. Context matching uses the
existing Workbench keybinding service. Removing another package's binding with a `-command` entry
is unsupported. See the optional [keymap package](../../extensions/keymap-sublime/package.json).

## Using the API

```ts
import * as ash from '@ash/sdk';

export function activate(context: ash.ExtensionContext): void {
  context.subscriptions.push(ash.commands.register('example.read', async path => {
    if (typeof path !== 'string') throw new TypeError('Expected a workspace path');
    return ash.files.readTextFile(path);
  }));
}
```

Declare the command in `package.json` and select `api: ash` in the current executable
extension declaration. Compile TypeScript to JavaScript and leave `@ash/sdk` external
when bundling. The product host resolves both ESM imports and CommonJS requires to its
bound implementation. See the [inspect example](../../examples/extensions/inspect/README.md).

The API includes `commands.register` and `commands.execute`, authorized UTF-8 file reads,
client-owned documents and configuration in `workspace`, UI and comparison operations in
`window`, language providers, tasks, debugging, terminal providers, speech and SCM providers.
Each group exposes implemented domain operations with self-contained TypeScript types.
Registration, execution and events retain their existing admission and disposal owners.

`languages.registerDocumentFormattingEditProvider` registers document formatting for
the selected language IDs. The provider receives an immutable document snapshot,
indentation options and a cancellation token, and returns `TextEdit[]`; the host
applies current-version edits through its existing undo and save owners. Disposing
the registration or disabling the extension withdraws the provider.

`languages.getJsonSchemaContributions()` reads detached JSON schemas and their file
patterns from the window's schema registry. `languages.onDidChangeJsonSchemas`
invalidates cached analysis when schemas or associations change. The consuming
[`json-language-features`](../../extensions/json-language-features/README.md) extension
owns JSON/JSONC editing enhancements; neither API grants schema mutation or network
access. Configuration parsing and comment-preserving file editing remain host-owned.

`context.storage.get(key)` reads a fresh JSON value from this extension's profile state;
`update(key, value)` stores one value, or removes it with `undefined`. Missing keys return
`undefined`; JSON `null` remains a stored value. SQLite applies each key update to the latest
saved data, so two windows writing different keys do not overwrite one another. Reads and
writes are asynchronous and uncached. Compound data can be stored as one JSON value.
Limits are 256 keys per namespace, 1024 UTF-8 bytes per key, 256 KiB total serialized data,
and 64 levels of JSON nesting. This is ordinary state; never put credentials here.

`context.secrets.get/store/delete` use the existing profile SecretStore through private
Host RPC. `get` returns a UTF-8 string or `undefined`; `store` accepts a string (including
empty); `delete` reports whether a value existed. Keys are non-secret identifiers up to
256 UTF-8 bytes without control characters, and values are limited to 64 KiB. The SDK
keeps no value cache. Persistence follows the existing profile mode: encrypted by default
or private-file storage explicitly selected by the user. Failures do not change modes or
request system authorization.

The host binds both namespaces to the admitted source and extension. Authors cannot
select another package, profile or product credential key. Cancellation, deadline and
retirement belong to the host; writes with uncertain results are never replayed. Revocation,
disable and uninstall retain saved data but retire access. A fresh exact grant admits a new
instance without reviving an old handle. No public snapshot/revision, CAS, polling, cursor
or reset contract is provided. Standalone trusted Worker storage is unavailable.

`files.readTextFile` runs in the existing Rust filesystem service, inherits the callback's authority,
cancellation and deadline, and fails after cancellation or extension retirement. The Rust
service enforces package permission, directory containment and a 256 KiB read budget.
The current read path requires a local Plugin with explicit package and directory-read
grants; signed registry JavaScript deployments currently deny workspace filesystem reads.
Unsaved editor text belongs to the client-owned document APIs in `workspace`; filesystem
reads return persisted bytes. `window.openComparison` accepts text, binary and multiple
comparison inputs without granting access to arbitrary editor transport operations.

This is API version 1 of the Ash author contract. It does not provide arbitrary backend
RPC, a service container, compatibility modules or
arbitrary third-party Renderer execution. The existing package and authorization managers
remain authoritative. `.ashx` packaging is separate migration work;
the current package declaration is still used by the local installer.

Browser extensions can declare `contributes.imageEditors` and register each entry
with `window.registerImageEditorProvider`. Its public provider supplies an
`ImageEditorView`: HTML, immutable package assets registered with `asWebviewUri`,
and JSON initialization state. This uses the existing versioned capability
registration/invocation path. A manifest entry alone cannot execute a view.
`window.showImageEditor` accepts screen or code-selection input for the calling
extension's own registered editor. Accepted views belong to that registration and
window, independently of the initiating command's RPC deadline.

The view runs in an opaque sandbox. It requests initialization with
`{ type: 'initialize' }`, receives `ImageEditorInput`, and posts `{ type: 'ready' }`
after rendering. Input contains screen pixels or an immutable `CodeImageSnapshot`,
semantic theme values and provider state. Feature verbosity preferences belong
to the extension's state. The view exposes no
service container, editor objects, internal CSS names or IPC. A view posts
`{ type: 'complete', result: ImageEditorCompletion }`; the host validates PNG output
before performing copy, save or attachment. `{ type: 'completed', accepted, error }`
reports completion or a cancelled save dialog to the same view. Registration
retirement cancels active interactions. Other execution hosts do not currently
grant the `imageEditor` capability.

On macOS, input can contain `permission: { applicationName, icon }` instead of
screen pixels. The extension renders its consent guide in a movable companion
window, using its normal theme, localization and verbosity settings. In this phase
only, `{ type: 'permission', action: ImageEditorPermissionAction }` requests opening
System Settings (`settings`), dragging the running application (`drag`), copying
its path (`copyPath`), checking consent and resuming capture (`retry`), or cancelling
(`cancel`). Start `drag` from the view's `dragstart` event after preventing the
browser's default drag. The host replies with `{ type: 'permissionResult', action,
accepted, error }`. Different actions can complete out of order; match replies by
`action` so opening Settings cannot delay a native drag. Extensions cannot supply
paths, grant access or run these actions from a normal image editor. `retry`
succeeds only when macOS reports permission granted.
Returning focus to the guide or its owning Ash window also resumes capture when
macOS reports permission granted; an explicit continue button is optional.
The host opens the screen-recording pane automatically before showing the guide
and keeps the companion near the System Settings window using window metadata.
When Ash already has Accessibility permission, the companion anchors directly
below the recording list's add/remove controls. The host never requests this
additional permission automatically.

`ImageEditorView.html` may contain standalone inline HTML, styles and scripts.
Optional Blob scripts and styles must be registered with `asWebviewUri`; any
number may appear in document order. No particular bundler or paired script/CSS
output is required. Disposing the returned Provider registration closes its
active views even while the extension remains enabled. Code-image interactions
use the destination Chat draft's cancellation and image-attachment checks.

The declared completion API supports simple replacement ranges, text/snippet insertion and
additional text edits. Resolve callbacks, command-bearing items, insert/replace ranges and
unsupported completion kinds are excluded. Configuration `update(key, value, target)`
persists through the existing client configuration owner. Select `'user'` or `'workspace'`
explicitly; `undefined` removes that layer's override, while `null` is a value.
Language-override and folder writes are not supported. Configuration objects retain
their original read snapshot; obtain a fresh object after `onDidChangeConfiguration`
to observe committed values. Failed or cancelled writes are not retried; cancellation
does not roll back an already committed change. Workspace file
operations provide read/stat/directory listing, with `ctime` currently reported as zero.

`WorkspaceEdit.renameFile` is supported in language-provider edit results.
`workspace.applyEdit` applies text edits through the client model owner and rejects file
operations. Registry Remote resolvers currently use workspace scope; profile-scoped local
Plugin resolvers remain a separate admitted deployment path.

Debug visualizers may declare `contributes.debugVisualizers` entries with `id`,
`title`, `command`, and optional exact variable `type`. Register that command through
`ash.commands.registerCommand`. Its argument contains `sessionId`, optional `threadId`
and `frameId`, and a variable snapshot (`name`, `value`, `type`, `variablesReference`).
Return `{ content: string, languageId?: string }` (at most 1 MiB). Debug's Visualize
Variable command presents the result in a read-only editor. The existing command
activation, execution authorization and extension lifetime apply; results from a
resumed session or replaced extension catalog are discarded. This contract renders
text; extension HTML and scripts are not executed in the editor.

Extensions admitted with the `treeView` capability can call
`views.registerTreeDataProvider(provider, { id, title, containerId? })`. Registration
contributes a view to the current window; omitting `containerId` selects its default
primary sidebar container. The provider owns elements and implements `getChildren`
and `getTreeItem`. Stable `TreeItem.id` values retain identity across refreshes;
otherwise identity follows the element object. Labels, descriptions, string tooltips,
collapse state and commands are supported. Set `checkboxState` with a
`setCheckboxState` callback to enable checkboxes, or `editable: true` with `rename`
to enable F2 editing. Enter commits the name and Escape cancels it.

Fire `onDidChangeTreeData` to refresh the tree. Refreshes wait for active inline edits
to finish, preserving typed text and selection. The renderer uses the existing view,
selection, theme and accessibility owners; it keeps only a projection of provider data.
Disposing the registration or retiring the extension removes the view and cancels
in-flight requests. Nodes are bounded to 10,000 per provider, item text to 4,096
characters, IDs to 1,024 characters and rename input to 32,768 characters.

### Product window metadata

Declare `ashUiTargets` in an editor extension's `package.json` as `["ide"]`, `["agents"]`, or `["ide", "agents"]`. Package builders preserve it as `uiTargets` in the signed market `catalog.json`; local Plugin manifests use `uiTargets` directly. Marketplace, details and recommendations consume this declaration. Omission preserves an unknown audience for legacy packages and does not imply shared support. Recommendation rules and capability types cannot override it. This metadata is separate from OS/runtime compatibility and execution authorization.

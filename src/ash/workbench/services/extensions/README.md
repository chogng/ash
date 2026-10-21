# Declarative extension resources

> This README owns the Workbench implementation contract for manifest parsing, contribution
> preparation, and registration lifecycle. The cross-layer product behavior and trust model are
> canonical in [`docs/editor-extensions.md`](../../../../../docs/editor-extensions.md); Rust
> filesystem catalog details are in
> [`crates/external-ext/src/packages/README.md`](../../../../../crates/external-ext/src/packages/README.md).

This service is the Workbench composition boundary for static extension packages. The Rust App Server
selects, validates and freezes built-in and authorized external package directories through
`ash-external-ext::packages`, then supplies their catalog and resources through one interface.
The TS adapter binds resource generations to the backend connection without a static catalog fallback.
Runtime adapters convert transport DTOs; this service
owns Workbench catalog types and decides which supported declarative contributions become active.
The executable host waits for this catalog owner to finish its initial commit before accepting a
provider fleet: terminal package identities and extension configuration defaults must exist before
provider callbacks run. A registered service instance alone does not establish that readiness.
It never executes extension JavaScript or gives extensions editor DOM, model, Worker-port, or host
filesystem access.

`platform/extensionResourceLoader` owns resource URI interpretation, strict UTF-8 decoding and binary reads.
`IExtensionApi.resources` is the same service registered in the window scope. The App Server adapter
binds its source callbacks; disconnected clients report unavailability. Contribution loaders keep their
candidate resource caches, and test pages explicitly inject the prepared resource fixture.
Installed reads retain the catalog generation. The App Server adapter coalesces identical reads and
retains up to 64 verified resources of at most 128 KiB each (8 MiB total). It clears them on catalog
or connection replacement, never retains failures or larger resources, and returns independent byte
buffers. Retired source gallery-resource requests and package parsing have been removed.
Historical installed package identities remain available for disablement and uninstall; they
cannot enter this catalog, obtain a lease or execute code.

TS/JS authors use `@ash/sdk` and `ash.*`. The shared `ash.js` facade binds editor and UI
operations to their client services and authorized backend operations to Rust. This declarative
loader continues to own resource parsing and registration, while Node, optional V8 and trusted
Workers own execution. The [extension architecture](../../../../../docs/editor-extensions.md#0-确定的产品方向)
records actual API coverage, authorization and the remaining runtime/platform limitations.

Built-in and valid Ash-source packages retain their existing resource identities and licenses.
Their supported manifest contributions share this catalog; executable entries require separate
runtime admission and never run as a side effect of resource loading. Static loaders refresh on
Extensions changes, including removal and updates.

## Ownership

| Area                                                             | Owner                                           | Current contract                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Trusted roots, immutable package snapshot, digest and generation | `ash-external-ext::packages::ExtensionPackages` | External authority packages before profile roots; built-ins are client assets                   |
| Renderer transport and exact-shape normalization                 | `platform/extensions/*`                         | `IExtensionApi.list` and its shared `IExtensionResourceLoaderService`                           |
| Workbench catalog/domain types                                   | `common/extensionService.ts`                    | Does not expose generated DTO or manifest JSON                                                  |
| Supported manifest parsing                                       | `parseExtensionManifest`                        | Identity plus languages, grammars, snippets, color/icon themes, and debuggers                   |
| Workbench lifecycle                                              | `AppServerExtensionService`                     | Serialized/coalesced refresh with full candidate preparation and one event-barrier commit       |
| Selectable color themes                                          | `ExtensionColorThemeService`                    | Portable/standard manifests, resource loading, replaceable registrations, and renderer lifetime |
| Syntax parsing and queries                                       | `workbench/services/treeSitter`                 | Shared Rust tree on Desktop; a Tree-sitter Worker on Web                                        |
| Language/configuration/completion                                | Stanza language services                        | Caller-owned disposable registrations                                                           |
| Declarative Debug Adapter lookup                                 | `ExtensionDebugAdapterRegistry`                 | Unique debugger type to bounded command descriptor                                              |

## Supported contribution projection

| Contribution                          | Projection                                                                                                  | Current limitation                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `languages`                           | Language identity, file/MIME/first-line associations                                                        | No manifest localization                                                                                                     |
| language `configuration`              | Parsed JSONC to Stanza language configuration                                                               | Only the existing Stanza configuration vocabulary                                                                            |
| `snippets`                            | Prefix-bearing snippets become completion providers; file templates power `New File from Template`          | Template bodies create language-tagged untitled editors                                                                      |
| `grammars`                            | Validated legacy manifest metadata                                                                          | Resources are not loaded; syntax requires a supported Tree-sitter grammar                                                    |
| `themes`                              | Parsed metadata catalog; `ExtensionColorThemeService` independently owns selectable color themes            | Package-relative JSON `include` is resolved before registration; manifest NLS placeholders use deterministic fallback labels |
| `iconThemes`                          | Package-relative fonts and SVG/PNG file icons; selectable through `workbench.iconTheme`                     | File associations and light variants; folder-specific associations are not consumed by the current file label contract       |
| `productIconThemes`                   | Package-relative SVG artwork for semantic product icon IDs; selectable through `workbench.productIconTheme` | Unspecified IDs keep Ash's built-in SVG artwork                                                                              |
| `problemMatchers` / `problemPatterns` | Bounded named patterns, matcher inheritance and background declarations enter the task matcher registry     | Search-based file locations remain incomplete                                                                                |
| `debuggers`                           | Unique type, label, adapter program, and args                                                               | Discovery only; execution requires an admitted Ash provider                                                                  |

`configurationDefaults` enters the configuration registry with the extension's schemas in one
validated replacement. Language defaults such as Markdown word wrapping participate in normal
configuration precedence; they do not write user settings. Disabling or removing the extension
withdraws its defaults along with its schemas.

`semanticTokenScopes`, extension JavaScript, LSP declarations, and dynamic
UI are not activated by this loader.

Built-in `customEditors` declarations can select product renderers registered through
`registerBuiltinEditorPane`. Both the package ID and view type must match an existing factory;
user and Extensions packages cannot select these factories. The loader prepares filename/MIME
selectors and localized editor labels before replacing the package's pane registrations as one
batch. A rejected batch preserves the previous available editors; removal or window shutdown
releases the registrations. This mechanism activates the packaged `media-preview` editors and
does not execute extension JavaScript or acquire text models for binary media. Workbench and
Sessions both start this declarative loader.

Workbench and Sessions create `WebWorkerExtensionHost` for built-in `browser` entries obtained from the same enabled Rust package catalog used by declarative loaders. It owns the window's extension Workers alongside the App Server executable-host transport.
The Worker entry lives in `workbench/api/worker/extensionHostWorker.ts`; editor callback contracts
live in `workbench/api/common/extHost.protocol.ts`. `platform/agentHost` owns the App Server
transport, invocation cancellation and wire validation, without importing Workbench contracts.
`build/builtin/extensions.ts` bundles each browser entry and its dependencies into an immutable ES
module and stages it inside the complete package directory. Rust supplies its catalog and bytes;
user/registry readability does not admit a browser Worker. Activation receives the window language,
registration callbacks, and command execution.
`MainThreadExtensionApi` installs extension commands and manifest editor menus. Command categories
prefix palette labels while menus retain short titles, and declared enablement gates menu actions.
Worker client requests queue at the host's concurrency limit; SCM state publication keeps its
incarnation lifetime when an unrelated read callback is cancelled.
SCM resource groups retain their identity within each snapshot. History command contexts sent back
by an extension resolve to that extension's live repository before invoking Workbench commands.
`MainThreadEditors` reconstructs text and byte comparisons from plain descriptors and retains
read-only version bytes and binary metadata without requiring a filesystem provider.
`MainThreadCustomEditors` installs text-backed editor providers in the shared pane registry.
The Markdown package under `extensions/markdown-language-features` owns its preview rendering and
actions. `WebviewEditor` hosts the content, and `CustomTextEditorModel` holds a reference to the same
text state used by the source editor. The host prepares HTML during input loading and creates
the sandbox document when its pane first becomes visible; this keeps the first navigation out of
a hidden editor host. Independent custom tabs retain their editor ID in working sets.
Browser packages use the same Ash author API and bounded registration owner as the other hosts.

Browser reconciliation reads the enabled Rust package catalog but retains healthy Workers with the
same package/manifest digests, version, provenance, execution location/platform and window
language. Removal or changed identity revokes the old registrations before bounded SDK cleanup
and replacement; failed Workers can be retried. Refreshing for a remote activation does not
restart an unchanged browser package or cancel its pending calls. A retained runtime carries
its latest acknowledged SCM/status-bar registrations through other packages' activation.
Packaged browser entries currently activate during reconciliation; this path does not implement
backend JS manifest event scheduling. See [host lifecycle mechanisms](../../../../../docs/editor-extensions.md#浏览器-worker-与后端宿主的生命周期).

Theme documents accept the four supported `uiTheme` values, hexadecimal colors,
package-relative JSON `include` files, and direct type/modifier styles in
`semanticTokenColors`. Tree-sitter syntax and language-server semantic tokens use the
same active color theme. TextMate `tokenColors`, `.tmTheme` resources and scope mappings
are unsupported. Unknown Workbench color IDs remain catalog data but are ignored
when compiling product color themes. Publisher metadata is ignored at the extension
resource boundary; user theme documents retain their complete-value schema.

Product icon themes use the manifest entry `{ "id": "my-icons", "label": "My icons", "path": "./icons/theme.json" }`.
The referenced JSONC file maps icon IDs to package-relative SVG resources:

```json
{ "iconDefinitions": { "add": { "iconPath": "./add.svg" } } }
```

Each SVG needs a `viewBox` and may contain basic shapes and their drawing attributes. Scripts,
styles, external references, and paths outside the package are rejected before registration.
`workbench.productIconTheme` selects one contribution by ID; `default` selects Ash's built-in
`lxicons` SVGs. Theme changes update icons already displayed in the window.

## Execution and refresh path

```text
IExtensionApi.list("cached" | "refresh")
  -> adapt transport descriptors to Workbench candidates
  -> parseExtensionManifest
  -> load/parse language configurations, snippets, color themes, and SVG icon themes
  -> prepare language, completion, file-template, theme, and debugger registrations
  -> commit all domain registrations behind the synchronous event barrier
  -> dispose previous registrations
```

Theme startup requests the initial source scan. Declarative startup, enablement changes and backend
package notifications read the authoritative Rust snapshot with `cached`, which still checks managed
package generations and discovers sources when no snapshot exists. Explicit `reload()` uses `refresh`
to detect source edits outside package management. No renderer-owned catalog replaces backend checks.
Browser host reconciliation also reads the current backend snapshot: refreshing runtime instances
does not imply another package source scan. Package identities and generation-bound resource reads
still determine which Workers can be retained or must be retired.

Only one runner loads at a time. Concurrent `start()` readiness checks share its current transaction;
refresh requests and source notifications still queue one follow-up read. A forced source refresh takes
precedence over a cached read. All waiters resolve after that follow-up drains. An idle transport queue
sends the first catalog request immediately so backend work overlaps synchronous Workbench construction.
The snippet transaction owner is constructed on its initial service lookup, before the catalog starts;
its completion contribution can be created later without invalidating prepared resources.
Disposal prevents in-flight work from committing or emitting a regular failure and suppresses any
queued follow-up.

The Workbench composition root retains the initial `start()` promise and waits for it before
restoring working-copy backups and advancing to `AfterRestored`. A transition from any non-`ready`
App Server state to `ready` requests a new backend snapshot through the same queue. The transport API
does not expose cancellation, so disposal suppresses commit and follow-up work but cannot physically
abort an already dispatched RPC.

Candidate resources and grammars are fully parsed before commit. Commit runs behind the shared
synchronous event barrier: language, completion, file-template, extension-theme,
debugger, grammar, and `IExtensionService` events are delivered only after every live owner holds
the same candidate generation. A synchronous commit failure discards buffered candidate events and
restores the previous generation.

`ExtensionColorThemeService` loads color-theme contributions through the same generation-bound
resource loader and owns their Workbench registrations. Independent themes and their include chains
load through a pool of at most eight tasks and publish in manifest order after all admitted work settles.
External documents are validated once by their resource owner; materializing their merged typed theme
does not repeat the document schema pass.

Desktop constructs services and Parts while the initial theme load runs. Its container stays inert,
and startup contributions, view restoration, first layout and `Ready` wait for that theme promise;
startup failure disposes the constructed Workbench. Sessions still awaits themes before construction. The UI-only transport serves a build-generated copy of
`extensions/theme-defaults`; connected windows read the packaged extension resources. Both use
the same manifest parser, `include` resolver, and registry. The metadata catalog above does not
register color themes a second time. Active-theme changes reach the shared Tree-sitter theme adapter through `IThemeService`.

Candidate resources are always read with the candidate catalog generation. A Rust refresh therefore
cannot make one parsed manifest load resource bytes from another generation. Refreshes with identical
descriptors, package digests, and diagnostics retain that generation, so startup loaders and other
windows can rescan without invalidating each other's resource reads. When catalog contents change, generation conflict is
reported as a failed candidate refresh; the service does not silently retry individual files against
a newer catalog.

## Failure semantics

Manifest, language configuration, snippet, theme, debugger, or candidate registration failure
disposes the candidate store and retains the previous active Workbench catalog. `onDidFail` reports
the candidate extension when known. A successful commit publishes `onDidChange` after replacing
dependent registries.

Legacy TextMate grammar declarations remain validated metadata. They do not trigger resource reads,
grammar compilation, tokenization Workers, or an additional activation-readiness barrier. Bundled
Tree-sitter grammars and queries own syntax. Other declaration failures still preserve the previous
complete catalog through the same prepare/commit boundary.

## Internal symbols and drift signals

| Symbol                                                                        | Responsibility                                           | Modification impact                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `parseExtensionManifest`                                                      | Strict supported manifest subset and safe resource paths | Fixtures for every contribution and bundled manifests                        |
| `AppServerExtensionService.loadAndRegister`                                   | One candidate generation prepare/commit/rollback         | Reload queue, last-good, dispose, legacy grammar non-loading tests           |
| reload runner state                                                           | Coalesce concurrent refreshes and settle all waiters     | Concurrency and disposal tests                                               |
| `loadLanguageConfiguration` / `loadSnippetFile` / `loadTheme` / `loadGrammar` | Generation-bound UTF-8 resource decoding                 | Invalid UTF-8, path, size, resource adapter tests                            |
| `ExtensionThemeRegistry`                                                      | Parsed metadata catalog                                  | Catalog prepare/commit tests                                                 |
| `ExtensionColorThemeService` / `WorkbenchThemesRegistry`                      | Manifest-contributed selectable color themes             | Selection, registration lifetime, theme inheritance, and token styling tests |
| `ExtensionFileTemplateRegistry`                                               | Immutable queryable template catalog                     | Materialization and create-from-template command tests                       |
| `ExtensionDebugAdapterRegistry`                                               | Immutable unique-type command lookup                     | Debug fallback/duplicate tests                                               |

Transport DTO imports in the public `IExtensionService` contract, direct workspace/URL reads,
extension-owned DOM callbacks, or contribution semantics implemented inside the Rust catalog are
architecture drift.

## Tests and current limitations

Run:

```text
pnpm test:extensions
pnpm typecheck:extensions
pnpm test:unit
pnpm typecheck:renderer
pnpm test:build-tools
```

Tests cover strict manifest/resource normalization, all supported contribution shapes, language
configuration/snippet/template/theme/debugger projection, repeat and queued reload, failure rollback,
dispose during load, legacy grammar non-loading, and bounded resource chunk assembly. Packaging
tests separately enumerate all bundled manifests and their referenced files.

This declarative service has no Editor Extension installer, enablement database, signature
authority, manifest NLS, or arbitrary extension runtime. Ash's executable Host RPC v1 is a
separate Plugin-authorized service under `workbench/services/extensionHost`; it is not an evolution
of this loader. The shared Ash author API preserves its existing domain and lifecycle owners;
retired author modules and source adapters are no longer execution paths. The current runtime
and platform boundaries are documented in `docs/editor-extensions.md`.

Problem contributions are prepared with the complete declarative catalog. Invalid regular
expressions, missing references, duplicate names and cyclic bases reject replacement before
publication. A failed refresh preserves the previous matcher set. Package removal or loader
disposal releases its registrations; already running collectors retain their execution snapshot.

Tasks and Debug resolve `${extensionInstallFolder:publisher.name}` through
`IExtensionService.getExtension`. The existing catalog preserves the validated installation URI;
execution paths follow its host platform. Lookup waits for catalog loading, reads the current catalog
without activating the extension, and does not retain a separate cache. Missing or disabled extensions
have no resolvable installation folder. An unchanged package and adapter declaration retain their
factory identity across scan revisions, so a path lookup awaiting refresh does not revoke a launch.
Package changes or removal still retire that executable owner.

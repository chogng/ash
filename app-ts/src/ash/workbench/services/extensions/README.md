# Declarative extension resources

> This README owns the Workbench implementation contract for manifest parsing, contribution
> preparation, and registration lifecycle. The cross-layer product behavior and trust model are
> canonical in [`docs/editor-extensions.md`](../../../../../../docs/editor-extensions.md); Rust
> filesystem catalog details are in
> [`ash-rs/extensions/README.md`](../../../../../../ash-rs/extensions/README.md).

This service is the Workbench composition boundary for static extension packages. Rust owns
discovery and immutable resource authority; runtime adapters convert transport DTOs; this service
owns Workbench catalog types and decides which supported declarative contributions become active.
It never executes extension JavaScript or gives extensions editor DOM, model, Worker-port, or host
filesystem access.

## Ownership

| Area | Owner | Current contract |
| --- | --- | --- |
| Trusted roots, immutable package snapshot, digest and generation | `ash-extensions::ExtensionCatalog` | Built-in first, profile second; direct child packages only |
| Renderer transport and exact-shape normalization | `platform/extensions/*` | `IExtensionApi.list` and generation-bound `readResource` |
| Workbench catalog/domain types | `common/extensionService.ts` | Does not expose generated DTO or manifest JSON |
| Supported manifest parsing | `parseExtensionManifest` | Identity plus languages, grammars, snippets, color/icon themes, and debuggers |
| Workbench lifecycle | `AppServerExtensionService` | Serialized/coalesced refresh with full candidate preparation and one event-barrier commit |
| Grammar/Worker materialization | `workbench/services/textMate` | Latest complete catalog and independent failure event |
| Language/configuration/completion | Stanza language services | Caller-owned disposable registrations |
| Declarative Debug Adapter lookup | `ExtensionDebugAdapterRegistry` | Unique debugger type to bounded command descriptor |

## Supported contribution projection

| Contribution | Projection | Current limitation |
| --- | --- | --- |
| `languages` | Language identity, file/MIME/first-line associations | No manifest localization |
| language `configuration` | Parsed JSONC to Stanza language configuration | Only the existing Stanza configuration vocabulary |
| `snippets` | Prefix-bearing snippets become completion providers; file templates power `New File from Template` | Template bodies create language-tagged untitled editors |
| `grammars` | Root/injection loader plus advanced embedded/token/bracket metadata | TextMate service owns later materialization |
| `themes` | Strictly parsed versioned catalog, selectable Workbench color themes, and active TextMate token projection | Package-relative JSON `include` is resolved before registration; manifest NLS placeholders use deterministic fallback labels |
| `iconThemes` | Package-relative fonts and SVG/PNG file icons; selectable through `workbench.iconTheme` | File associations and light variants; folder-specific associations are not consumed by the current file label contract |
| `productIconThemes` | Package-relative SVG artwork for semantic product icon IDs; selectable through `workbench.productIconTheme` | Unspecified IDs keep Ash's built-in SVG artwork |
| `debuggers` | Unique type, label, adapter program, and args | Discovery only; no VS Code Debug Extension API |

`configurationDefaults`, `semanticTokenScopes`, extension JavaScript, LSP declarations, and dynamic
UI are not activated by this loader.

Theme documents accept the four supported `uiTheme` values, hexadecimal colors, package-relative
JSON `include` files, `tokenColors` arrays or package-relative TextMate theme files, and semantic token styles. Token
settings use `foreground`, `background`, and supported `fontStyle` values. Unknown
Workbench color token IDs remain catalog data but are ignored when compiling product color themes.

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
IExtensionApi.list("refresh")
  -> adapt transport descriptors to Workbench candidates
  -> parseExtensionManifest
  -> load/parse language configurations, snippets, color themes, and SVG icon themes
  -> prepare language, grammar, completion, file-template, theme, and debugger registrations
  -> await the candidate TextMate grammar catalog
  -> commit all domain registrations behind the synchronous event barrier
  -> dispose previous registrations
```

Only one runner loads at a time. Calls arriving during an active load set one queued refresh; all
waiters resolve after the runner and that coalesced follow-up drain. Disposal prevents in-flight
work from committing or emitting a regular failure and suppresses any queued follow-up.

The Workbench composition root retains the initial `start()` promise and waits for it before
restoring working-copy backups and advancing to `AfterRestored`. A transition from any non-`ready`
App Server state to `ready` calls `reload()` and therefore uses the same queue. The transport API
does not expose cancellation, so disposal suppresses commit and follow-up work but cannot physically
abort an already dispatched RPC.

Candidate resources and grammars are fully parsed before commit. Commit runs behind the shared
synchronous event barrier: language, completion, file-template, Workbench-theme, extension-theme,
debugger, grammar, and `IExtensionService` events are delivered only after every live owner holds
the same candidate generation. A synchronous commit failure discards buffered candidate events and
restores the previous generation.

Candidate resources are always read with the candidate catalog generation. A Rust refresh therefore
cannot make one parsed manifest load resource bytes from another generation. Generation conflict is
reported as a failed candidate refresh; the service does not silently retry individual files against
a newer catalog.

## Failure semantics

Manifest, language configuration, snippet, theme, debugger, or candidate registration failure
disposes the candidate store and retains the previous active Workbench catalog. `onDidFail` reports
the candidate extension when known. A successful commit publishes `onDidChange` after replacing
dependent registries.

TextMate owns grammar parsing and catalog normalization. The extension service asks it to materialize
the candidate before committing; a loader/parser failure is therefore also surfaced through
`IExtensionService.onDidFail` and leaves the previous complete catalog active. Later Worker runtime
failures remain TextMate-owned and must not move grammar parsing into this service.

## Internal symbols and drift signals

| Symbol | Responsibility | Modification impact |
| --- | --- | --- |
| `parseExtensionManifest` | Strict supported manifest subset and safe resource paths | Fixtures for every contribution and bundled manifests |
| `AppServerExtensionService.loadAndRegister` | One candidate generation prepare/commit/rollback | Reload queue, last-good, dispose, TextMate readiness tests |
| reload runner state | Coalesce concurrent refreshes and settle all waiters | Concurrency and disposal tests |
| `loadLanguageConfiguration` / `loadSnippetFile` / `loadTheme` / `loadGrammar` | Generation-bound UTF-8 resource decoding | Invalid UTF-8, path, size, resource adapter tests |
| `ExtensionThemeRegistry` / `WorkbenchThemesRegistry` | Parsed catalog and replaceable Workbench themes | Selection, fallback label, token projection tests |
| `ExtensionFileTemplateRegistry` | Immutable queryable template catalog | Materialization and create-from-template command tests |
| `ExtensionDebugAdapterRegistry` | Immutable unique-type command lookup | Debug fallback/duplicate tests |

Transport DTO imports in the public `IExtensionService` contract, direct workspace/URL reads,
extension-owned DOM callbacks, or contribution semantics implemented inside the Rust catalog are
architecture drift.

## Tests and current limitations

Run:

```text
pnpm --dir app-ts test:extensions
pnpm --dir app-ts typecheck:extensions
pnpm --dir app-ts test:unit
pnpm --dir app-ts typecheck:renderer
pnpm --dir app-ts test:build-tools
```

Tests cover strict manifest/resource normalization, all supported contribution shapes, language
configuration/snippet/template/theme/debugger projection, repeat and queued reload, failure rollback,
dispose during load, TextMate candidate readiness, and bounded resource chunk assembly. Packaging
tests separately enumerate all bundled manifests and their referenced files.

This declarative service has no Editor Extension installer, enablement database, signature
authority, manifest NLS, or arbitrary extension runtime. Ash's executable Host RPC v1 is a
separate Plugin-authorized service under `workbench/services/extensionHost`; it is not an evolution
of this loader and is not a VS Code/Node Extension Host. The two current boundaries and remaining
product-integration limits are documented in `docs/editor-extensions.md`.

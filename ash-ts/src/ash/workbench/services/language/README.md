# Workbench language service

`workbench/services/language` owns product adapters and product-level language
composition. The shared language identity, editing configuration, and provider
registries are separate Editor services; Workbench registers App Server and
product providers into those contracts without subclassing or wrapping them.

`WorkbenchLanguageFeatures` installs built-in identities/configurations and JSON
providers. App Server, extension-host, TextMate, codebase-symbols, and future LSP
adapters register directly through `ILanguageFeaturesService` registries. Every
registration is disposable and independent of per-document service lifetimes.

The reusable default language data lives in
`editor/standalone/common/builtinLanguages.ts`. Standalone and Workbench choose
to register it during assembly; `editor/common` does not import it. File models
receive the Workbench language configuration service and observe subsequent
extension registrations. A directly constructed `TextModel` without language
configuration has no language-specific editing rules and creates no services.

The filename split is intentional:

| Filename family | Owner | Responsibility |
| --- | --- | --- |
| `browser/workbenchLanguageFeatures.ts` | Workbench | Product-owned built-in language and JSON provider composition |
| `browser/appServer*Providers.ts` | Workbench | App Server DTO-to-Editor provider adaptation |
| `editor/common/services/languageService.ts` | Editor | Language identity and file association |
| `editor/common/services/languageConfigurationService.ts` | Editor | Composable editing rules |
| `editor/common/services/languageFeatures*.ts` | Editor | Provider registry contract and implementation |
| `TextModel.bracketPairs`, model tokenization | Editor model | Bracket structure and token data consumed by editing features |
| `editor/contrib/folding/browser/` | Editor contribution | Folding range providers, tracked fold state, commands, and browser projection; it consumes language configuration but does not own language infrastructure |
| `languageCompletionSession*`, `languageDiagnostic*`, `languageTokenLineIndex.ts` | Editor language layer | Version gates, session state, and browser-facing result projection |
| `*Provider*`, `*Worker*`, `*Wire*` | Owning Editor or Workbench layer | Editor owns provider/worker contracts; Workbench owns product and transport adapters |

The editor language layer still owns the contracts and editor semantics consumed by those
providers: bracket and pair editing, folding state, completion
sessions/snippets, result version gates, and browser presentation. This service
does not move those responsibilities into Workbench.

## LSP boundary

The LSP client and server lifecycle live below the Renderer in
`ash-rs/lsp`, `ash-rs/lsp-manager`, and the App Server. This Workbench
service owns only the frontend adapters in `browser/appServerLanguageProviders.ts`
and `browser/appServerLanguageDiagnosticsService.ts`. The provider adapter exposes
hover, completion, cross-file navigation, call/type hierarchy, workspace symbols,
rename, code actions, document/range formatting, parameter hints, inlay hints,
and linked editing through
editor-owned contracts. The diagnostics adapter
reference-counts open models, debounces authoritative document synchronization,
closes the App Server document after the final editor releases it, and aggregates
push diagnostics with editor-published parser diagnostics by resource and revision.

The editor merges current-revision LSP diagnostics with parser diagnostics in its
existing decoration collection; stale revisions are hidden immediately after an
edit. The Workbench-owned Problems panel enumerates the complete shared workspace
repository, groups diagnostics by resource, filters by severity/message/file,
and delegates row navigation to `IEditorPart`; it does not inspect editor DOM or
own diagnostic production. Document pull reports share the open-model revision
gate; workspace reports are projected through App Server's Workspace filesystem
authority and retain unopened resources in the same repository. Semantic tokens
and the remaining LSP document features use editor-owned provider contracts.
Formatting edits use the editor command/undo layer; parameter hints retain provider-selected active
signatures and parameters; inlay hints remain non-mutating; linked ranges extend
editor input before commit so every synchronized change is one atomic undo step.
Regardless of origin, revision gates, application semantics, and DOM projection
stay editor-owned.

Language-server log and show-message notifications are adapted by the Workbench
language status service. Each server owns a channel registered through the
canonical [`OutputService`](../output/README.md); the generic Output panel owns
channel selection and clearing. User-visible messages use the shared dialog
service. Active work-done progress is summarized through a transient statusbar
entry, which is removed when no operation remains.

TextMate is a separate provider under `workbench/services/textMate`. Without a registered grammar, models expose plain text; diagnostics come from registered language providers.

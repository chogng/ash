# Ash TextMate adapter

`workbench/services/textMate` adapts TextMate grammars to Stanza's versioned Syntax
provider contract. It is a Workbench service adapter for Stanza editors, not
part of `base`, and it
does not own workspace files, extension manifests, product color tokens,
documents, or the Stanza view. It does own the serializable scope-to-semantic
theme projection needed inside its Worker. Its browser boundary owns only
caller-supplied grammar loaders and Worker composition; extension package files
belong to the extension resource layer.

## Ownership

| Capability | Owner | Status |
| --- | --- | --- |
| Grammar contribution identity and revision snapshots | `TextMateGrammarRegistry` | ✅ |
| Transferable grammar catalogs and materialization | `TextMateGrammarCatalogModel` / `materializeTextMateGrammarCatalog` | ✅ |
| Atomic Worker catalog state and side-channel transport | `TextMateGrammarCatalogStore` / catalog wire | ✅ |
| TextMate runtime and incremental line-state cache | `TextMateTokenizationService` | ✅ |
| Scope-to-Stanza token vocabulary mapping | `TextMateScopeResolver` | ✅, replaceable |
| Revisioned selector rules and Worker theme transport | `TextMateScopeThemeModel` / scope-theme wire | ✅ |
| Stanza Syntax provider/module adaptation | `createTextMateSyntaxProvider` / `createTextMateSyntaxModule` | ✅ |
| Catalog-gated Syntax Worker composition | `TextMateSyntaxModuleWorkerClient` / `browser/textMateSyntaxWorkerMain.ts` | ✅ |
| Browser Worker Oniguruma WASM loading | `browser/textMateOniguruma.ts` | ✅ |
| Grammar contribution-to-catalog lifecycle | `TextMateGrammarService` | ✅ |
| Workbench service composition and lifecycle | `ITextMateService` / `BrowserTextMateService` | ✅ |
| Declarative language, configuration, snippet, grammar, and theme resources | `extensions` / `AppServerExtensionService` | ✅ manifest projection and active-theme token-color projection |
| External extension-manifest loading | `AppServerExtensionService` | Static declarative contributions only; extension JavaScript is never executed |

`workbench/services/textMate/common` may depend on Stanza's public Syntax and text
contracts because it adapts into that domain. Stanza and `base` must not import
TextMate runtime types. `workbench/services/textMate/browser` is the only layer that knows
the `onig.wasm` asset URL or uses `fetch`.

## Grammar contract

`TextMateGrammarRegistry.register` accepts a root grammar, an injection grammar,
or both:

- `scopeName` is the unique TextMate identity;
- an optional concrete `languageId` selects the one root grammar for that
  language;
- `injectTo` declares root scopes that should load the grammar as an injection;
- `loadGrammar` returns raw JSON/plist text or a parsed `IRawGrammar`.

Registrations are caller-owned and disposable. Every change publishes a new
immutable `TextMateGrammarRegistrySnapshot`; old snapshots remain internally
consistent. `materializeTextMateGrammarCatalog` resolves one snapshot into a
bounded, structured-clone-safe content catalog. The renderer-side catalog model
requires strictly increasing revisions.

Grammar loading deliberately does not accept a URI or `IFileService`.
Extension/resource ownership must resolve and validate a contribution before
supplying its loader. This keeps Worker tokenization independent of platform
I/O and prevents `base` from learning editor concepts.

`TextMateGrammarService` is the renderer-side contribution service. It owns
registrations, cancels superseded materialization, publishes only the newest
complete catalog, and preserves the last good revision when a loader fails.
`whenReady()` lets a composition root gate work on the latest requested
revision; `onDidFailCatalog` reports a failed revision without corrupting the
catalog already used by a Worker.

The JSON and JSONC grammars are shipped as the declarative `json` package under
`extensions`. Rust discovers
the package and serves its bounded grammar resources through the extension API;
the browser TextMate service only receives validated loaders. Neither common code
nor the dedicated Worker reads product or workspace files. Workbench constructs one
`BrowserTextMateService`, registers it as
`ITextMateService`, and passes it to Stanza panes. `AppServerExtensionService`
then projects Rust-discovered static grammar contributions into the same
registry. The service owns the shared grammar catalog and scope theme; each
Stanza editor part creates and disposes only its dedicated TextMate Syntax Worker.
Languages without a grammar remain plain text.

Direct `createBrowserEditorPart` callers may omit the service and get a
private `BrowserTextMateService`; that compatibility path is session-owned and
does not change Workbench ownership.

## Tokenization path

1. `TextMateTokenizationService` captures the current grammar snapshot.
2. A `vscode-textmate.Registry` loads the requested root grammar and its
   injections against that exact snapshot.
3. Lines tokenize in order with immutable `StateStack` input/output state.
4. The scope resolver maps named scopes to Stanza token types and exact token presentation.
5. Relative line tokens aggregate into an immutable `LanguageTokenResult`.
6. `createTextMateSyntaxProvider` publishes the result through Stanza's
   request-version and application gates.

The default resolver maps conventional comment, string, regexp, number,
operator, keyword, function, type, parameter, variable, tag, property,
constant, punctuation, and invalid scopes. `TextMateScopeThemeModel` adds
ordered, serializable selectors with overrides limited to Stanza's stable
semantic token-type and modifier vocabulary. It
supports comma unions, outer-to-inner scope sequences, segment wildcards, and
scope exclusions. Last matching rule wins before the stable fallback resolver.
The renderer mirrors each revision through `TextMateScopeThemeWireClient`; the
Worker atomically replaces its model, drops cached token styles, and performs
the next syntax request with the new rules.

TextMate uses `tokenPriority: 100` and declares `*`. It returns `undefined`
when the catalog has no root grammar for a language. Token providers run in
descending priority; equal priorities preserve registration order. Without an
applicable provider, the model has no syntax tokens or invented diagnostics.

## Worker catalog path

`TextMateGrammarCatalogWireClient` sends complete validated catalog revisions
over the same structural port used by Stanza's Syntax and provider-module
protocols. `TextMateGrammarCatalogWireServer` atomically builds a new registry
before swapping the Worker-side store. Stale or malformed revisions poison the
catalog client and invalidate that Worker so Stanza's coordinator can rebuild it
from the catalog source's current revision.

`TextMateSyntaxModuleWorkerClient` serializes catalog and scope-theme updates
and gates every Syntax request on the latest scheduled revisions. The dedicated browser Worker
activates `textmate.grammars`; it owns the catalog
store, scope-theme model, TextMate service, Oniguruma runtime, provider registries, and all four
wire servers. A replacement Worker accepts the source's current revision even
when its revision is greater than one.

## Incremental state

The service owns one latest tokenization document per loaded language. It compares
old and new line arrays, reuses the unchanged prefix, and rescans from the first
changed line until an unchanged suffix line has the same TextMate input
`StateStack`. The remaining suffix is then reused without tokenization.
`synchronizeDocument` eagerly applies the same path when Stanza's Worker mirror
publishes a model transaction.

A grammar registry revision creates a new runtime generation. Requests already
using an old generation finish against their captured snapshot; its TextMate
registry is disposed after the last request releases it. Same-model-version
requests therefore cannot reuse state produced by an older grammar revision.

## Failure semantics

- invalid scope/language identities and duplicate roots fail before mutation;
- a loader returning a different root scope rejects that request;
- cancellation is checked before grammar load, after asynchronous load, and
  between every line;
- a TextMate `stoppedEarly` result rejects the provider instead of publishing a
  structurally incomplete state stack;
- resolver output is validated before it enters Stanza;
- service disposal does not dispose the caller's grammar registry or
  Oniguruma promise.

Stanza's Syntax host isolates provider failure and keeps its versioned store
unchanged or publishes the host's empty fallback according to the existing
lane contract.

## Current limitations

- The bundled pack includes CSS, HTML, JavaScript, JSON/JSONC, Markdown, Python, Rust, Shell,
  SQL, TypeScript, XML, YAML, and four self-contained default themes. Rust still owns discovery
  and bounded resource reads; this adapter does not scan arbitrary directories;
- `embeddedLanguages`, `tokenTypes`, `balancedBracketScopes`, and
  `unbalancedBracketScopes` are validated, transported into `vscode-textmate`, and projected as
  Stanza `LanguageToken` language/bracket metadata for embedded editing and bracket matching;
- extension `themes` are parsed into a versioned catalog. The active Workbench color scheme selects
  the matching extension theme and projects its token colors, including exact foreground,
  background, and font styles, into the TextMate scope theme;
- `configurationDefaults`, `semanticTokenScopes`, extension JavaScript, and LSP declarations are
  intentionally ignored by this declarative loader. LSP providers must enter through the separate
  Stanza language-provider contract;
- the cache aggregates a complete renderer token array after line reuse;
- `BrowserTextMateService` owns the grammar registry and matching Worker
  factory; `AppServerExtensionService` supplies declarative package loaders and
  Workbench injects the service into Stanza panes;
- Stanza editor parts schedule a new syntax request when the catalog or scope theme changes;
  other consumers must still make that scheduling decision explicitly.

Tests under `test/common` load the real `vscode-oniguruma` WASM binary and a
real TextMate grammar. They cover registry revisions, injections, cross-line
strings, scope mapping, one-line suffix reuse, multiline convergence,
same-version grammar replacement, cancellation, ownership, malformed loaders,
provider priority/fallback, catalog materialization, atomic replacement,
structured-clone catalog/theme updates, stale-client poisoning, dynamic Worker
catalog/theme changes, embedded-language/bracket metadata, active-theme projection, exact token
presentation, and end-to-end Stanza Syntax requests. A standalone Vite build checks
the complete browser Worker and emitted WASM asset. The real bundled JSON
grammar is also tokenized through the common service in the Node test realm.

# TextMate browser boundary

This directory owns browser and dedicated-Worker runtime details only.

`createBrowserTextMateOnigLib` resolves Vite's `onig.wasm` asset URL, fetches
the binary once per realm, initializes `vscode-oniguruma`, and exposes only the
`IOnigLib` contract required by `vscode-textmate`.

`createBrowserTextMateTokenizationService` combines that runtime with a
caller-owned grammar snapshot source. The returned service is caller-owned.
Neither runtime helper loads extension manifests, grammar resources, themes,
or Stanza models.

`BrowserTextMateGrammarService` is the browser-side grammar boundary. It does not
discover files or import product grammar assets. `BrowserTextMateService` accepts caller-owned
`TextMateGrammarDefinition` contributions plus an optional caller-owned
`TextMateScopeThemeSource`, and registers them into that session before any
Worker is created. Later selector revisions are mirrored into the existing
Worker. `AppServerExtensionService` is the composition-root adapter for static
extension grammars. It resolves manifest-relative paths through `IExtensionApi`,
supplies loaders to the common grammar service, and never grants the Worker
filesystem or extension-host access.

`textMateSyntaxWorkerMain.ts` is the complete dedicated Worker composition:
it owns the TextMate grammar module, the grammar catalog and scope-theme
stores, the Syntax/module/catalog/theme wire servers, and the Oniguruma-backed tokenization
service. `createTextMateSyntaxWorkerFactory` creates the matching renderer
client and gates requests on the latest catalog and scope-theme revisions supplied
by the caller-owned sources.

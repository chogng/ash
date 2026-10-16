# Scope theme compatibility

This directory contains pure theme adapters only. Tree-sitter is the syntax engine;
there is no TextMate tokenizer, Oniguruma runtime, grammar catalog or dedicated
TextMate Worker.

- `common/textMateScopeTheme.ts` validates versioned scope-theme rules and resolves
  selectors against a scope stack. Each Workbench owns its `TextMateScopeThemeModel`.
- `common/textMateScopeResolver.ts` maps conventional scope names onto editor token categories.
- `common/textMateThemeProjection.ts` adapts existing extension token colors and user
  `editor.tokenColorCustomizations.textMateRules` to the same theme vocabulary.

Workbench and Sessions feed the active `IThemeService` color theme into these
adapters. Tree-sitter captures are mapped to theme scopes by
`workbench/services/treeSitter/browser/treeSitterLibraryService.ts`. The token
inspector reports the actual model's captures and their mapped theme scopes.

`.tmTheme` files remain supported by the bounded property-list reader in
`workbench/services/themes/common/colorThemeData.ts`; it does not load an XML
runtime, fetch external declarations, or depend on a syntax tokenizer.

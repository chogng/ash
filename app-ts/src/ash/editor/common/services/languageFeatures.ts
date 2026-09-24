import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { type LanguageFeatureRegistry, type LanguageCompletionProviderRegistry, type SyntaxProviderRegistry } from '../languageFeatureRegistry.js';
import type { LanguageSelector } from '../languageSelector.js';
import type * as languages from '../languages.js';

/** Provider registries shared by standalone callers and Workbench adapters. */
export interface ILanguageFeaturesService extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly syntaxProvider: SyntaxProviderRegistry;
	readonly completionProvider: LanguageCompletionProviderRegistry;
	readonly codeActionProvider: LanguageFeatureRegistry<languages.LanguageCodeActionProvider>;
	readonly codeLensProvider: LanguageFeatureRegistry<languages.CodeLensProvider>;
	readonly documentSymbolProvider: LanguageFeatureRegistry<languages.LanguageDocumentSymbolProvider>;
	readonly documentFormattingEditProvider: LanguageFeatureRegistry<languages.DocumentFormattingEditProvider>;
	readonly documentRangeFormattingEditProvider: LanguageFeatureRegistry<languages.DocumentRangeFormattingEditProvider>;
	readonly onTypeFormattingEditProvider: LanguageFeatureRegistry<languages.OnTypeFormattingEditProvider>;
	readonly hoverProvider: LanguageFeatureRegistry<languages.LanguageHoverProvider>;
	readonly inlayHintsProvider: LanguageFeatureRegistry<languages.LanguageInlayHintsProvider>;
	readonly inlineCompletionsProvider: LanguageFeatureRegistry<languages.LanguageInlineCompletionsProvider>;
	readonly linkedEditingRangeProvider: LanguageFeatureRegistry<languages.LinkedEditingRangeProvider>;
	readonly linkProvider: LanguageFeatureRegistry<languages.LanguageLinkProvider>;
	readonly signatureHelpProvider: LanguageFeatureRegistry<languages.LanguageParameterHintsProvider>;
	readonly renameProvider: LanguageFeatureRegistry<languages.LanguageRenameProvider>;
	readonly colorProvider: LanguageFeatureRegistry<languages.LanguageColorProvider>;
	readonly definitionProvider: LanguageFeatureRegistry<languages.LanguageDefinitionProvider>;
	readonly declarationProvider: LanguageFeatureRegistry<languages.LanguageDeclarationProvider>;
	readonly implementationProvider: LanguageFeatureRegistry<languages.LanguageImplementationProvider>;
	readonly typeDefinitionProvider: LanguageFeatureRegistry<languages.LanguageTypeDefinitionProvider>;
	readonly referenceProvider: LanguageFeatureRegistry<languages.LanguageReferenceProvider>;
	readonly workspaceSymbolProvider: LanguageFeatureRegistry<languages.LanguageWorkspaceSymbolProvider>;
	readonly callHierarchyProvider: LanguageFeatureRegistry<languages.LanguageCallHierarchyProvider>;
	readonly typeHierarchyProvider: LanguageFeatureRegistry<languages.LanguageTypeHierarchyProvider>;
	readonly documentSemanticTokensProvider: LanguageFeatureRegistry<languages.LanguageSemanticTokensProvider>;
	readonly foldingRangeProvider: LanguageFeatureRegistry<languages.LanguageFoldingRangeProvider>;
	readonly selectionRangeProvider: LanguageFeatureRegistry<languages.LanguageSelectionRangeProvider>;
	readonly documentHighlightProvider: LanguageFeatureRegistry<languages.DocumentHighlightProvider>;
	readonly multiDocumentHighlightProvider: LanguageFeatureRegistry<languages.MultiDocumentHighlightProvider>;
	readonly documentPasteEditProvider: LanguageFeatureRegistry<languages.DocumentPasteEditProvider>;
	readonly documentDropEditProvider: LanguageFeatureRegistry<languages.DocumentDropEditProvider>;
	setNotebookTypeResolver(resolver: import('../languageFeatureRegistry.js').NotebookInfoResolver | undefined): void;
	registerProviderBatch(providers: LanguageProviderBatch): LanguageProviderBatchRegistration;
}

export const ILanguageFeaturesService = createServiceIdentifier<ILanguageFeaturesService>('ILanguageFeaturesService');

/** One runtime generation contributing several provider kinds atomically. */
export interface LanguageProviderBatchEntry<TProvider> {
	readonly selector: LanguageSelector;
	readonly provider: TProvider;
}

export interface LanguageProviderBatch {
	readonly completions?: readonly languages.LanguageCompletionProvider[];
	readonly hovers?: readonly LanguageProviderBatchEntry<languages.LanguageHoverProvider>[];
	readonly formatting?: readonly LanguageProviderBatchEntry<languages.DocumentFormattingEditProvider | languages.DocumentRangeFormattingEditProvider | languages.OnTypeFormattingEditProvider>[];
	readonly inlayHints?: readonly LanguageProviderBatchEntry<languages.LanguageInlayHintsProvider>[];
	readonly linkedEditing?: readonly LanguageProviderBatchEntry<languages.LinkedEditingRangeProvider>[];
	readonly parameterHints?: readonly LanguageProviderBatchEntry<languages.LanguageParameterHintsProvider>[];
}

export interface LanguageProviderBatchRegistration extends IDisposable {
	replace(providers: LanguageProviderBatch): void;
}

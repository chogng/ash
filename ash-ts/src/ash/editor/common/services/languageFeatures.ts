import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import type { LanguageFeatureRegistry } from '../languageFeatureRegistry.js';
import type { LanguageSelector } from '../languageSelector.js';
import type { LanguageCompletionProvider, LanguageCompletionProviderRegistry } from '../languages/completion/languageCompletionProviders.js';
import type { CodeLensProvider, DocumentHighlightProvider, LinkedEditingRangeProvider, MultiDocumentHighlightProvider, LanguageFormattingProvider, LanguageSemanticTokensProvider } from '../languages.js';
import type { SyntaxProviderRegistry } from '../languages/syntax/syntaxProviders.js';
import type { LanguageWorkspaceSymbolProvider } from '../languages/workspaceSymbols.js';
import type { LanguageCallHierarchyProvider, LanguageTypeHierarchyProvider } from '../../contrib/callHierarchy/common/languageHierarchy.js';
import type { LanguageCodeActionProvider } from '../../contrib/codeAction/common/languageCodeActions.js';
import type { LanguageColorProvider } from '../../contrib/colorPicker/common/languageColors.js';
import type { LanguageDocumentSymbolProvider } from '../../contrib/documentSymbols/common/languageDocumentSymbols.js';
import type { LanguageFoldingRangeProvider } from '../../contrib/folding/common/languageFoldingRanges.js';
import type { LanguageDeclarationProvider, LanguageDefinitionProvider, LanguageImplementationProvider, LanguageReferenceProvider, LanguageTypeDefinitionProvider } from '../../contrib/gotoSymbol/common/languageNavigation.js';
import type { LanguageHoverProvider } from '../../contrib/hover/common/hover.js';
import type { LanguageInlayHintsProvider } from '../../contrib/inlayHints/common/languageInlayHints.js';
import type { LanguageInlineCompletionsProvider } from '../../contrib/inlineCompletions/common/inlineCompletions.js';
import type { LanguageLinkProvider } from '../../contrib/links/common/languageLinks.js';
import type { LanguageParameterHintsProvider } from '../../contrib/parameterHints/common/languageParameterHints.js';
import type { LanguageRenameProvider } from '../../contrib/rename/common/languageRename.js';
import type { LanguageSelectionRangeProvider } from '../../contrib/smartSelect/common/selectionRanges.js';

/** Provider registries shared by standalone callers and Workbench adapters. */
export interface ILanguageFeaturesService extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly syntaxProvider: SyntaxProviderRegistry;
	readonly completionProvider: LanguageCompletionProviderRegistry;
	readonly codeActionProvider: LanguageFeatureRegistry<LanguageCodeActionProvider>;
	readonly codeLensProvider: LanguageFeatureRegistry<CodeLensProvider>;
	readonly documentSymbolProvider: LanguageFeatureRegistry<LanguageDocumentSymbolProvider>;
	readonly documentFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>;
	readonly documentRangeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>;
	readonly onTypeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>;
	readonly hoverProvider: LanguageFeatureRegistry<LanguageHoverProvider>;
	readonly inlayHintsProvider: LanguageFeatureRegistry<LanguageInlayHintsProvider>;
	readonly inlineCompletionsProvider: LanguageFeatureRegistry<LanguageInlineCompletionsProvider>;
	readonly linkedEditingRangeProvider: LanguageFeatureRegistry<LinkedEditingRangeProvider>;
	readonly linkProvider: LanguageFeatureRegistry<LanguageLinkProvider>;
	readonly signatureHelpProvider: LanguageFeatureRegistry<LanguageParameterHintsProvider>;
	readonly renameProvider: LanguageFeatureRegistry<LanguageRenameProvider>;
	readonly colorProvider: LanguageFeatureRegistry<LanguageColorProvider>;
	readonly definitionProvider: LanguageFeatureRegistry<LanguageDefinitionProvider>;
	readonly declarationProvider: LanguageFeatureRegistry<LanguageDeclarationProvider>;
	readonly implementationProvider: LanguageFeatureRegistry<LanguageImplementationProvider>;
	readonly typeDefinitionProvider: LanguageFeatureRegistry<LanguageTypeDefinitionProvider>;
	readonly referenceProvider: LanguageFeatureRegistry<LanguageReferenceProvider>;
	readonly workspaceSymbolProvider: LanguageFeatureRegistry<LanguageWorkspaceSymbolProvider>;
	readonly callHierarchyProvider: LanguageFeatureRegistry<LanguageCallHierarchyProvider>;
	readonly typeHierarchyProvider: LanguageFeatureRegistry<LanguageTypeHierarchyProvider>;
	readonly documentSemanticTokensProvider: LanguageFeatureRegistry<LanguageSemanticTokensProvider>;
	readonly foldingRangeProvider: LanguageFeatureRegistry<LanguageFoldingRangeProvider>;
	readonly selectionRangeProvider: LanguageFeatureRegistry<LanguageSelectionRangeProvider>;
	readonly documentHighlightProvider: LanguageFeatureRegistry<DocumentHighlightProvider>;
	readonly multiDocumentHighlightProvider: LanguageFeatureRegistry<MultiDocumentHighlightProvider>;
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
	readonly completions?: readonly LanguageCompletionProvider[];
	readonly hovers?: readonly LanguageProviderBatchEntry<LanguageHoverProvider>[];
	readonly formatting?: readonly LanguageProviderBatchEntry<LanguageFormattingProvider>[];
	readonly inlayHints?: readonly LanguageProviderBatchEntry<LanguageInlayHintsProvider>[];
	readonly linkedEditing?: readonly LanguageProviderBatchEntry<LinkedEditingRangeProvider>[];
	readonly parameterHints?: readonly LanguageProviderBatchEntry<LanguageParameterHintsProvider>[];
}

export interface LanguageProviderBatchRegistration extends IDisposable {
	replace(providers: LanguageProviderBatch): void;
}

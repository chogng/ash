import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { TextResourceLanguageInput } from '../../../platform/language/common/textResourceLanguage.js';
import { RGBA8 } from '../../common/core/misc/rgba.js';
import * as languages from '../../common/languages.js';
import { selectLanguageIds, type LanguageSelector } from '../../common/languageSelector.js';
import { type LanguageConfiguration } from '../../common/languages/languageConfiguration.js';
import type { ILanguageExtensionPoint } from '../../common/languages/language.js';
import type { LanguageDescriptionChangeEvent, LanguageDescriptionContribution, LanguageDescriptionRegistration } from '../../common/services/languagesRegistry.js';
import type { LanguageProviderBatch, LanguageProviderBatchRegistration } from '../../common/services/languageFeatures.js';
import { StandaloneServices } from './standaloneServices.js';

export interface IStandaloneLanguagesApi {
	readonly LanguageCompletionInsertTextFormat: typeof languages.LanguageCompletionInsertTextFormat;
	readonly LanguageCompletionItemKind: typeof languages.LanguageCompletionItemKind;
	readonly LanguageCompletionTriggerKind: typeof languages.LanguageCompletionTriggerKind;
	readonly LanguageDiagnosticSeverity: typeof languages.LanguageDiagnosticSeverity;
	readonly DocumentHighlightKind: typeof languages.DocumentHighlightKind;
	readonly RGBA8: typeof RGBA8;
	readonly register: typeof register;
	readonly registerLanguages: typeof registerLanguages;
	readonly resolveLanguageId: typeof resolveLanguageId;
	readonly onDidChangeLanguages: Event<LanguageDescriptionChangeEvent>;
	readonly setLanguageConfiguration: typeof setLanguageConfiguration;
	readonly registerProviderBatch: typeof registerProviderBatch;
	readonly registerSyntaxProvider: typeof registerSyntaxProvider;
	readonly registerCompletionItemProvider: typeof registerCompletionItemProvider;
	readonly registerCodeActionProvider: typeof registerCodeActionProvider;
	readonly registerCodeLensProvider: typeof registerCodeLensProvider;
	readonly registerDocumentSymbolProvider: typeof registerDocumentSymbolProvider;
	readonly registerDocumentFormattingEditProvider: typeof registerDocumentFormattingEditProvider;
	readonly registerDocumentRangeFormattingEditProvider: typeof registerDocumentRangeFormattingEditProvider;
	readonly registerOnTypeFormattingEditProvider: typeof registerOnTypeFormattingEditProvider;
	readonly registerHoverProvider: typeof registerHoverProvider;
	readonly registerInlayHintsProvider: typeof registerInlayHintsProvider;
	readonly registerInlineCompletionsProvider: typeof registerInlineCompletionsProvider;
	readonly registerLinkedEditingRangeProvider: typeof registerLinkedEditingRangeProvider;
	readonly registerLinkProvider: typeof registerLinkProvider;
	readonly registerSignatureHelpProvider: typeof registerSignatureHelpProvider;
	readonly registerRenameProvider: typeof registerRenameProvider;
	readonly registerColorProvider: typeof registerColorProvider;
	readonly registerDefinitionProvider: typeof registerDefinitionProvider;
	readonly registerDeclarationProvider: typeof registerDeclarationProvider;
	readonly registerImplementationProvider: typeof registerImplementationProvider;
	readonly registerTypeDefinitionProvider: typeof registerTypeDefinitionProvider;
	readonly registerReferenceProvider: typeof registerReferenceProvider;
	readonly registerWorkspaceSymbolProvider: typeof registerWorkspaceSymbolProvider;
	readonly registerCallHierarchyProvider: typeof registerCallHierarchyProvider;
	readonly registerTypeHierarchyProvider: typeof registerTypeHierarchyProvider;
	readonly registerDocumentSemanticTokensProvider: typeof registerDocumentSemanticTokensProvider;
	readonly registerFoldingRangeProvider: typeof registerFoldingRangeProvider;
	readonly registerSelectionRangeProvider: typeof registerSelectionRangeProvider;
	readonly registerDocumentHighlightProvider: typeof registerDocumentHighlightProvider;
	readonly registerMultiDocumentHighlightProvider: typeof registerMultiDocumentHighlightProvider;
}

export function register(language: ILanguageExtensionPoint): void {
	StandaloneServices.get().languageService.registerLanguage(language);
}

export function registerLanguages(contributions: readonly LanguageDescriptionContribution[]): LanguageDescriptionRegistration {
	return StandaloneServices.get().languageService.registerLanguages(contributions);
}

export function resolveLanguageId(input: TextResourceLanguageInput): string | undefined {
	return StandaloneServices.get().languageService.resolveLanguageId(input);
}

export const onDidChangeLanguages: Event<LanguageDescriptionChangeEvent> = listener => StandaloneServices.get().languageService.languages.onDidChange(listener);

export function setLanguageConfiguration(languageId: string, configuration: LanguageConfiguration): IDisposable {
	return StandaloneServices.get().languageConfigurationService.register(languageId, configuration);
}

/** Ash worker providers can still be replaced as one runtime generation. */
export function registerProviderBatch(providers: LanguageProviderBatch): LanguageProviderBatchRegistration {
	return StandaloneServices.get().languageFeaturesService.registerProviderBatch(providers);
}

/** Ash snapshot tokenization and diagnostics use one worker-oriented provider contract. */
export function registerSyntaxProvider(provider: languages.SyntaxProvider): IDisposable {
	return StandaloneServices.get().languageFeaturesService.syntaxProvider.register(provider);
}

export function registerCompletionItemProvider(languageSelector: LanguageSelector, provider: Omit<languages.LanguageCompletionProvider, 'languageIds'>): IDisposable {
	return StandaloneServices.get().languageFeaturesService.completionProvider.register(withLanguageSelector(languageSelector, provider));
}

export function registerCodeActionProvider(languageSelector: LanguageSelector, provider: languages.LanguageCodeActionProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.codeActionProvider.register(languageSelector, provider); }
export function registerCodeLensProvider(languageSelector: LanguageSelector, provider: languages.CodeLensProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.codeLensProvider.register(languageSelector, provider); }
export function registerDocumentSymbolProvider(languageSelector: LanguageSelector, provider: languages.LanguageDocumentSymbolProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.documentSymbolProvider.register(languageSelector, provider); }
export function registerDocumentFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.DocumentFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get().languageFeaturesService.documentFormattingEditProvider.register(languageSelector, provider);
}

export function registerDocumentRangeFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.DocumentRangeFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get().languageFeaturesService.documentRangeFormattingEditProvider.register(languageSelector, provider);
}

export function registerOnTypeFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.OnTypeFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get().languageFeaturesService.onTypeFormattingEditProvider.register(languageSelector, provider);
}
export function registerHoverProvider(languageSelector: LanguageSelector, provider: languages.LanguageHoverProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.hoverProvider.register(languageSelector, provider); }
export function registerInlayHintsProvider(languageSelector: LanguageSelector, provider: languages.LanguageInlayHintsProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.inlayHintsProvider.register(languageSelector, provider); }
export function registerInlineCompletionsProvider(languageSelector: LanguageSelector, provider: languages.LanguageInlineCompletionsProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.inlineCompletionsProvider.register(languageSelector, provider); }
export function registerLinkedEditingRangeProvider(languageSelector: LanguageSelector, provider: languages.LinkedEditingRangeProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.linkedEditingRangeProvider.register(languageSelector, provider); }
export function registerLinkProvider(languageSelector: LanguageSelector, provider: languages.LanguageLinkProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.linkProvider.register(languageSelector, provider); }
export function registerSignatureHelpProvider(
	languageSelector: LanguageSelector,
	provider: languages.LanguageParameterHintsProvider,
): IDisposable {
	return StandaloneServices.get().languageFeaturesService.signatureHelpProvider.register(languageSelector, provider);
}
export function registerRenameProvider(languageSelector: LanguageSelector, provider: languages.LanguageRenameProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.renameProvider.register(languageSelector, provider); }
export function registerColorProvider(languageSelector: LanguageSelector, provider: languages.LanguageColorProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.colorProvider.register(languageSelector, provider); }
export function registerDefinitionProvider(languageSelector: LanguageSelector, provider: languages.LanguageDefinitionProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.definitionProvider.register(languageSelector, provider); }
export function registerDeclarationProvider(languageSelector: LanguageSelector, provider: languages.LanguageDeclarationProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.declarationProvider.register(languageSelector, provider); }
export function registerImplementationProvider(languageSelector: LanguageSelector, provider: languages.LanguageImplementationProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.implementationProvider.register(languageSelector, provider); }
export function registerTypeDefinitionProvider(languageSelector: LanguageSelector, provider: languages.LanguageTypeDefinitionProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.typeDefinitionProvider.register(languageSelector, provider); }
export function registerReferenceProvider(languageSelector: LanguageSelector, provider: languages.LanguageReferenceProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.referenceProvider.register(languageSelector, provider); }

/** Ash workspace and hierarchy providers remain host-wide registrations. */
export function registerWorkspaceSymbolProvider(provider: languages.LanguageWorkspaceSymbolProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.workspaceSymbolProvider.register('*', provider); }
export function registerCallHierarchyProvider(languageSelector: LanguageSelector, provider: languages.LanguageCallHierarchyProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.callHierarchyProvider.register(languageSelector, provider); }
export function registerTypeHierarchyProvider(languageSelector: LanguageSelector, provider: languages.LanguageTypeHierarchyProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.typeHierarchyProvider.register(languageSelector, provider); }

export function registerDocumentSemanticTokensProvider(
	languageSelector: LanguageSelector,
	provider: languages.LanguageSemanticTokensProvider,
): IDisposable {
	return StandaloneServices.get().languageFeaturesService.documentSemanticTokensProvider.register(languageSelector, provider);
}
export function registerFoldingRangeProvider(languageSelector: LanguageSelector, provider: languages.LanguageFoldingRangeProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.foldingRangeProvider.register(languageSelector, provider); }
export function registerSelectionRangeProvider(languageSelector: LanguageSelector, provider: languages.LanguageSelectionRangeProvider): IDisposable { return StandaloneServices.get().languageFeaturesService.selectionRangeProvider.register(languageSelector, provider); }

export function registerDocumentHighlightProvider(selector: LanguageSelector, provider: languages.DocumentHighlightProvider): IDisposable {
	return StandaloneServices.get().languageFeaturesService.documentHighlightProvider.register(selector, provider);
}

/** Ash's cross-document highlight provider carries its selector as part of the request owner. */
export function registerMultiDocumentHighlightProvider(provider: languages.MultiDocumentHighlightProvider): IDisposable {
	return StandaloneServices.get().languageFeaturesService.multiDocumentHighlightProvider.register(provider.selector, provider);
}

function languageIdsForSelector(selector: LanguageSelector): readonly string[] {
	const result = new Set<string>();
	selectLanguageIds(selector, result);
	if (result.size === 0) throw new TypeError('Language selector must identify at least one language');
	return Object.freeze([...result]);
}

function withLanguageSelector<TProvider extends object>(selector: LanguageSelector, provider: TProvider): TProvider & { readonly languageIds: readonly string[] } {
	if (!provider || typeof provider !== 'object') throw new TypeError('Language feature provider must be an object');
	return Object.freeze({ ...provider, languageIds: languageIdsForSelector(selector) });
}

export function createStandaloneLanguagesApi(): IStandaloneLanguagesApi {
	return Object.freeze({
		LanguageCompletionInsertTextFormat: languages.LanguageCompletionInsertTextFormat,
		LanguageCompletionItemKind: languages.LanguageCompletionItemKind,
		LanguageCompletionTriggerKind: languages.LanguageCompletionTriggerKind,
		LanguageDiagnosticSeverity: languages.LanguageDiagnosticSeverity,
		DocumentHighlightKind: languages.DocumentHighlightKind,
		RGBA8,
		register,
		registerLanguages,
		resolveLanguageId,
		onDidChangeLanguages,
		setLanguageConfiguration,
		registerProviderBatch,
		registerSyntaxProvider,
		registerCompletionItemProvider,
		registerCodeActionProvider,
		registerCodeLensProvider,
		registerDocumentSymbolProvider,
		registerDocumentFormattingEditProvider,
		registerDocumentRangeFormattingEditProvider,
		registerOnTypeFormattingEditProvider,
		registerHoverProvider,
		registerInlayHintsProvider,
		registerInlineCompletionsProvider,
		registerLinkedEditingRangeProvider,
		registerLinkProvider,
		registerSignatureHelpProvider,
		registerRenameProvider,
		registerColorProvider,
		registerDefinitionProvider,
		registerDeclarationProvider,
		registerImplementationProvider,
		registerTypeDefinitionProvider,
		registerReferenceProvider,
		registerWorkspaceSymbolProvider,
		registerCallHierarchyProvider,
		registerTypeHierarchyProvider,
		registerDocumentSemanticTokensProvider,
		registerFoldingRangeProvider,
		registerSelectionRangeProvider,
		registerDocumentHighlightProvider,
		registerMultiDocumentHighlightProvider,
	});
}

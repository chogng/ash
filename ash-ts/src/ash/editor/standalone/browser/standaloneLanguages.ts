import type { Event } from '../../../base/common/event.js';
import { DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import type { TextResourceLanguageInput } from '../../../platform/language/common/textResourceLanguage.js';
import { RGBA8 } from '../../common/core/misc/rgba.js';
import * as languages from '../../common/languages.js';
import { selectLanguageIds, type LanguageSelector } from '../../common/languageSelector.js';
import { type LanguageConfiguration } from '../../common/languages/languageConfiguration.js';
import { ILanguageService, type ILanguageExtensionPoint } from '../../common/languages/language.js';
import { ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import type { LanguageDescriptionChangeEvent, LanguageDescriptionContribution, LanguageDescriptionRegistration } from '../../common/services/languagesRegistry.js';
import { ILanguageFeaturesService, type LanguageProviderBatch, type LanguageProviderBatchRegistration } from '../../common/services/languageFeatures.js';
import { StandaloneServices } from './standaloneServices.js';
import { Color } from '../../../base/common/color.js';
import { LanguageId, MetadataConsts, StandardTokenType, TokenMetadata } from '../../common/encodedTokenAttributes.js';
import { IStandaloneThemeService } from '../common/standaloneTheme.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { IMonarchLanguage } from '../common/monarch/monarchTypes.js';
import { compile } from '../common/monarch/monarchCompile.js';
import { MonarchTokenizer } from '../common/monarch/monarchLexer.js';

export interface IToken {
	startIndex: number;
	scopes: string;
}

export interface ILineTokens {
	tokens: IToken[];
	endState: languages.IState;
}

export interface IEncodedLineTokens {
	tokens: Uint32Array;
	endState: languages.IState;
}

export interface TokensProvider {
	getInitialState(): languages.IState;
	tokenize(line: string, state: languages.IState): ILineTokens;
}

export interface EncodedTokensProvider {
	getInitialState(): languages.IState;
	tokenizeEncoded(line: string, state: languages.IState): IEncodedLineTokens;
	tokenize?(line: string, state: languages.IState): ILineTokens;
}

export interface TokensProviderFactory {
	create(): languages.ProviderResult<TokensProvider | EncodedTokensProvider | IMonarchLanguage>;
}

export interface IStandaloneLanguagesApi {
	readonly LanguageCompletionInsertTextFormat: typeof languages.LanguageCompletionInsertTextFormat;
	readonly LanguageCompletionItemKind: typeof languages.LanguageCompletionItemKind;
	readonly LanguageCompletionTriggerKind: typeof languages.LanguageCompletionTriggerKind;
	readonly LanguageDiagnosticSeverity: typeof languages.LanguageDiagnosticSeverity;
	readonly DocumentHighlightKind: typeof languages.DocumentHighlightKind;
	readonly RGBA8: typeof RGBA8;
	readonly register: typeof register;
	readonly getLanguages: typeof getLanguages;
	readonly onLanguage: typeof onLanguage;
	readonly onLanguageEncountered: typeof onLanguageEncountered;
	readonly getEncodedLanguageId: typeof getEncodedLanguageId;
	readonly setColorMap: typeof setColorMap;
	readonly setTokensProvider: typeof setTokensProvider;
	readonly setMonarchTokensProvider: typeof setMonarchTokensProvider;
	readonly registerTokensProviderFactory: typeof registerTokensProviderFactory;
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
	StandaloneServices.get(ILanguageService).registerLanguage(language);
}

export function getLanguages(): ILanguageExtensionPoint[] {
	const service = StandaloneServices.get(ILanguageService);
	return service.getRegisteredLanguageIds().map(languageId => {
		const description = service.languages.get(languageId)!;
		return {
			...description,
			aliases: description.aliases?.slice(),
			extensions: description.extensions?.slice(),
			filenames: description.filenames?.slice(),
			filenamePatterns: description.filenamePatterns?.slice(),
			mimetypes: description.mimetypes?.slice(),
		};
	});
}

export function onLanguage(languageId: string, callback: () => void): IDisposable {
	return StandaloneServices.withServices(() => onLanguageEvent(StandaloneServices.get(ILanguageService).onDidRequestRichLanguageFeatures, languageId, callback));
}

export function onLanguageEncountered(languageId: string, callback: () => void): IDisposable {
	return StandaloneServices.withServices(() => onLanguageEvent(StandaloneServices.get(ILanguageService).onDidRequestBasicLanguageFeatures, languageId, callback));
}

function onLanguageEvent(event: Event<string>, languageId: string, callback: () => void): IDisposable {
	const listener = event(encountered => {
		if (encountered === languageId) {
			listener.dispose();
			callback();
		}
	});
	return listener;
}

export function getEncodedLanguageId(languageId: string): number {
	const service = StandaloneServices.get(ILanguageService);
	return service.isRegisteredLanguageId(languageId) ? service.languageIdCodec.encodeLanguageId(languageId) : LanguageId.Null;
}

export function setColorMap(colorMap: string[] | null): void {
	const colors = colorMap?.map((color, index) => index === 0 ? Color.transparent : Color.fromHex(color)) ?? null;
	StandaloneServices.get(IStandaloneThemeService).setColorMapOverride(colors);
}

export function registerTokensProviderFactory(languageId: string, factory: TokensProviderFactory): IDisposable {
	const resources = new DisposableStore();
	let pending: Promise<languages.ITokenizationSupport | null> | undefined;
	resources.add(languages.TokenizationRegistry.registerFactory(languageId, {
		get tokenizationSupport() {
			return pending ??= Promise.resolve(factory.create()).then(provider => {
				if (!provider || resources.isDisposed) {
					return null;
				}
				if ('getInitialState' in provider) {
					return tokenizationSupport(languageId, provider as TokensProvider | EncodedTokensProvider);
				}
				return resources.add(createMonarchSupport(languageId, provider));
			});
		},
	}));
	return resources;
}

export function setTokensProvider(languageId: string, provider: TokensProvider | EncodedTokensProvider | PromiseLike<TokensProvider | EncodedTokensProvider>): IDisposable {
	if ('then' in provider) {
		return registerTokensProviderFactory(languageId, { create: () => Promise.resolve(provider) });
	}
	return languages.TokenizationRegistry.register(languageId, tokenizationSupport(languageId, provider));
}

export function setMonarchTokensProvider(languageId: string, languageDef: IMonarchLanguage | PromiseLike<IMonarchLanguage>): IDisposable {
	if ('then' in languageDef && typeof languageDef.then === 'function') {
		return registerTokensProviderFactory(languageId, { create: () => Promise.resolve(languageDef) });
	}
	const support = createMonarchSupport(languageId, languageDef as IMonarchLanguage);
	const resources = new DisposableStore();
	resources.add(support);
	resources.add(languages.TokenizationRegistry.register(languageId, support));
	return resources;
}

function createMonarchSupport(languageId: string, languageDef: IMonarchLanguage): MonarchTokenizer {
	if (!StandaloneServices.get(ILanguageService).isRegisteredLanguageId(languageId)) {
		throw new Error(`Cannot tokenize an unregistered language: ${languageId}`);
	}
	return StandaloneServices.get(IInstantiationService).createInstance(MonarchTokenizer, languageId, compile(languageId, languageDef));
}

function tokenizationSupport(languageId: string, provider: TokensProvider | EncodedTokensProvider): languages.ITokenizationSupport {
	const languageService = StandaloneServices.get(ILanguageService);
	if (!languageService.isRegisteredLanguageId(languageId)) {
		throw new Error(`Cannot tokenize an unregistered language: ${languageId}`);
	}
	const themes = StandaloneServices.get(IStandaloneThemeService);
	const encodedId = languageService.languageIdCodec.encodeLanguageId(languageId);
	return {
		getInitialState: () => provider.getInitialState(),
		tokenize(line, _hasEOL, state) {
			if (provider.tokenize) {
				const result = provider.tokenize(line, state);
				return { endState: result.endState, tokens: normalizeTokens(result.tokens, languageId) };
			}
			const result = (provider as EncodedTokensProvider).tokenizeEncoded(line, state);
			const tokens: languages.Token[] = [];
			for (let index = 0; index < result.tokens.length; index += 2) {
				const metadata = result.tokens[index + 1]!;
				const type = TokenMetadata.getTokenType(metadata);
				tokens.push({
					offset: result.tokens[index]!,
					type: type === StandardTokenType.Comment ? 'comment' : type === StandardTokenType.String ? 'string' : type === StandardTokenType.RegEx ? 'regexp' : 'other',
					language: languageService.languageIdCodec.decodeLanguageId(TokenMetadata.getLanguageId(metadata)),
				});
			}
			return { endState: result.endState, tokens };
		},
		tokenizeEncoded(line, _hasEOL, state) {
			if ('tokenizeEncoded' in provider) {
				return provider.tokenizeEncoded(line, state);
			}
			const result = provider.tokenize(line, state);
			const normalized = normalizeTokens(result.tokens, languageId);
			const tokens = new Uint32Array(normalized.length * 2);
			const theme = themes.getColorTheme().tokenTheme;
			normalized.forEach((token, index) => {
				tokens[index * 2] = token.offset;
				tokens[index * 2 + 1] = theme.match(encodedId, token.type) | MetadataConsts.BALANCED_BRACKETS_MASK;
			});
			return { endState: result.endState, tokens };
		},
	};
}

function normalizeTokens(tokens: IToken[], language: string): languages.Token[] {
	let offset = 0;
	return tokens.map((token, index) => {
		if (index > 0) {
			offset = Math.max(offset, token.startIndex);
		}
		return { offset, type: token.scopes, language };
	});
}

export function registerLanguages(contributions: readonly LanguageDescriptionContribution[]): LanguageDescriptionRegistration {
	return StandaloneServices.get(ILanguageService).registerLanguages(contributions);
}

export function resolveLanguageId(input: TextResourceLanguageInput): string | undefined {
	return StandaloneServices.get(ILanguageService).resolveLanguageId(input);
}

export const onDidChangeLanguages: Event<LanguageDescriptionChangeEvent> = (listener, thisArgs, disposables) => StandaloneServices.get(ILanguageService).languages.onDidChange(listener, thisArgs, disposables);

export function setLanguageConfiguration(languageId: string, configuration: LanguageConfiguration): IDisposable {
	return StandaloneServices.get(ILanguageConfigurationService).register(languageId, configuration);
}

/** Ash worker providers can still be replaced as one runtime generation. */
export function registerProviderBatch(providers: LanguageProviderBatch): LanguageProviderBatchRegistration {
	return StandaloneServices.get(ILanguageFeaturesService).registerProviderBatch(providers);
}

/** Ash snapshot tokenization and diagnostics use one worker-oriented provider contract. */
export function registerSyntaxProvider(provider: languages.SyntaxProvider): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).syntaxProvider.register(provider);
}

export function registerCompletionItemProvider(languageSelector: LanguageSelector, provider: Omit<languages.LanguageCompletionProvider, 'languageIds'>): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).completionProvider.register(withLanguageSelector(languageSelector, provider));
}

export function registerCodeActionProvider(languageSelector: LanguageSelector, provider: languages.LanguageCodeActionProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).codeActionProvider.register(languageSelector, provider); }
export function registerCodeLensProvider(languageSelector: LanguageSelector, provider: languages.CodeLensProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).codeLensProvider.register(languageSelector, provider); }
export function registerDocumentSymbolProvider(languageSelector: LanguageSelector, provider: languages.LanguageDocumentSymbolProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).documentSymbolProvider.register(languageSelector, provider); }
export function registerDocumentFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.DocumentFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).documentFormattingEditProvider.register(languageSelector, provider);
}

export function registerDocumentRangeFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.DocumentRangeFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).documentRangeFormattingEditProvider.register(languageSelector, provider);
}

export function registerOnTypeFormattingEditProvider(
	languageSelector: LanguageSelector,
	provider: languages.OnTypeFormattingEditProvider,
): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).onTypeFormattingEditProvider.register(languageSelector, provider);
}
export function registerHoverProvider(languageSelector: LanguageSelector, provider: languages.LanguageHoverProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).hoverProvider.register(languageSelector, provider); }
export function registerInlayHintsProvider(languageSelector: LanguageSelector, provider: languages.LanguageInlayHintsProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).inlayHintsProvider.register(languageSelector, provider); }
export function registerInlineCompletionsProvider(languageSelector: LanguageSelector, provider: languages.LanguageInlineCompletionsProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).inlineCompletionsProvider.register(languageSelector, provider); }
export function registerLinkedEditingRangeProvider(languageSelector: LanguageSelector, provider: languages.LinkedEditingRangeProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).linkedEditingRangeProvider.register(languageSelector, provider); }
export function registerLinkProvider(languageSelector: LanguageSelector, provider: languages.LanguageLinkProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).linkProvider.register(languageSelector, provider); }
export function registerSignatureHelpProvider(
	languageSelector: LanguageSelector,
	provider: languages.LanguageParameterHintsProvider,
): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).signatureHelpProvider.register(languageSelector, provider);
}
export function registerRenameProvider(languageSelector: LanguageSelector, provider: languages.LanguageRenameProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).renameProvider.register(languageSelector, provider); }
export function registerColorProvider(languageSelector: LanguageSelector, provider: languages.LanguageColorProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).colorProvider.register(languageSelector, provider); }
export function registerDefinitionProvider(languageSelector: LanguageSelector, provider: languages.LanguageDefinitionProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).definitionProvider.register(languageSelector, provider); }
export function registerDeclarationProvider(languageSelector: LanguageSelector, provider: languages.LanguageDeclarationProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).declarationProvider.register(languageSelector, provider); }
export function registerImplementationProvider(languageSelector: LanguageSelector, provider: languages.LanguageImplementationProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).implementationProvider.register(languageSelector, provider); }
export function registerTypeDefinitionProvider(languageSelector: LanguageSelector, provider: languages.LanguageTypeDefinitionProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).typeDefinitionProvider.register(languageSelector, provider); }
export function registerReferenceProvider(languageSelector: LanguageSelector, provider: languages.LanguageReferenceProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).referenceProvider.register(languageSelector, provider); }

/** Ash workspace and hierarchy providers remain host-wide registrations. */
export function registerWorkspaceSymbolProvider(provider: languages.LanguageWorkspaceSymbolProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).workspaceSymbolProvider.register('*', provider); }
export function registerCallHierarchyProvider(languageSelector: LanguageSelector, provider: languages.LanguageCallHierarchyProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).callHierarchyProvider.register(languageSelector, provider); }
export function registerTypeHierarchyProvider(languageSelector: LanguageSelector, provider: languages.LanguageTypeHierarchyProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).typeHierarchyProvider.register(languageSelector, provider); }

export function registerDocumentSemanticTokensProvider(
	languageSelector: LanguageSelector,
	provider: languages.LanguageSemanticTokensProvider,
): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).documentSemanticTokensProvider.register(languageSelector, provider);
}
export function registerFoldingRangeProvider(languageSelector: LanguageSelector, provider: languages.LanguageFoldingRangeProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).foldingRangeProvider.register(languageSelector, provider); }
export function registerSelectionRangeProvider(languageSelector: LanguageSelector, provider: languages.LanguageSelectionRangeProvider): IDisposable { return StandaloneServices.get(ILanguageFeaturesService).selectionRangeProvider.register(languageSelector, provider); }

export function registerDocumentHighlightProvider(selector: LanguageSelector, provider: languages.DocumentHighlightProvider): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).documentHighlightProvider.register(selector, provider);
}

/** Ash's cross-document highlight provider carries its selector as part of the request owner. */
export function registerMultiDocumentHighlightProvider(provider: languages.MultiDocumentHighlightProvider): IDisposable {
	return StandaloneServices.get(ILanguageFeaturesService).multiDocumentHighlightProvider.register(provider.selector, provider);
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
		getLanguages,
		onLanguage,
		onLanguageEncountered,
		getEncodedLanguageId,
		setColorMap,
		setTokensProvider,
		setMonarchTokensProvider,
		registerTokensProviderFactory,
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

import { runWithBufferedEvents } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { LanguageFeatureRegistry, type NotebookInfo, type NotebookInfoResolver } from '../languageFeatureRegistry.js';
import { type URI } from '../../../base/common/uri.js';
import { LanguageCompletionProviderRegistry, type LanguageCompletionProviderRegistration } from '../languages/completion/languageCompletionProviders.js';
import { createLanguageWordCompletionProvider } from '../languages/completion/languageWordCompletionProvider.js';
import type { CodeLensProvider, DocumentHighlightProvider, LinkedEditingRangeProvider, MultiDocumentHighlightProvider, DocumentFormattingEditProvider, LanguageFormattingProvider, LanguageSemanticTokensProvider } from '../languages.js';
import { createLanguageLexicalSyntaxProvider } from '../languages/languageLexicalSyntaxProvider.js';
import type { ILanguageConfigurationService } from '../languages/languageConfigurationRegistry.js';
import { SyntaxProviderRegistry } from '../languages/syntax/syntaxProviders.js';
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
import type { ILanguageFeaturesService, LanguageProviderBatch, LanguageProviderBatchEntry, LanguageProviderBatchRegistration } from './languageFeatures.js';

/** Owns the Editor provider registries without knowing their Workbench implementations. */
export class LanguageFeaturesService extends Disposable implements ILanguageFeaturesService {
	declare readonly _serviceBrand: undefined;
	public readonly syntaxProvider: SyntaxProviderRegistry;
	public readonly completionProvider: LanguageCompletionProviderRegistry;
	public readonly codeActionProvider: LanguageFeatureRegistry<LanguageCodeActionProvider>;
	public readonly codeLensProvider: LanguageFeatureRegistry<CodeLensProvider>;
	public readonly documentSymbolProvider: LanguageFeatureRegistry<LanguageDocumentSymbolProvider>;
	public readonly documentFormattingEditProvider: LanguageFeatureRegistry<DocumentFormattingEditProvider>;
	public readonly documentRangeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>;
	public readonly onTypeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>;
	public readonly hoverProvider: LanguageFeatureRegistry<LanguageHoverProvider>;
	public readonly inlayHintsProvider: LanguageFeatureRegistry<LanguageInlayHintsProvider>;
	public readonly inlineCompletionsProvider: LanguageFeatureRegistry<LanguageInlineCompletionsProvider>;
	public readonly linkedEditingRangeProvider: LanguageFeatureRegistry<LinkedEditingRangeProvider>;
	public readonly linkProvider: LanguageFeatureRegistry<LanguageLinkProvider>;
	public readonly signatureHelpProvider: LanguageFeatureRegistry<LanguageParameterHintsProvider>;
	public readonly renameProvider: LanguageFeatureRegistry<LanguageRenameProvider>;
	public readonly colorProvider: LanguageFeatureRegistry<LanguageColorProvider>;
	public readonly definitionProvider: LanguageFeatureRegistry<LanguageDefinitionProvider>;
	public readonly declarationProvider: LanguageFeatureRegistry<LanguageDeclarationProvider>;
	public readonly implementationProvider: LanguageFeatureRegistry<LanguageImplementationProvider>;
	public readonly typeDefinitionProvider: LanguageFeatureRegistry<LanguageTypeDefinitionProvider>;
	public readonly referenceProvider: LanguageFeatureRegistry<LanguageReferenceProvider>;
	public readonly workspaceSymbolProvider: LanguageFeatureRegistry<LanguageWorkspaceSymbolProvider>;
	public readonly callHierarchyProvider: LanguageFeatureRegistry<LanguageCallHierarchyProvider>;
	public readonly typeHierarchyProvider: LanguageFeatureRegistry<LanguageTypeHierarchyProvider>;
	public readonly documentSemanticTokensProvider: LanguageFeatureRegistry<LanguageSemanticTokensProvider>;
	public readonly foldingRangeProvider: LanguageFeatureRegistry<LanguageFoldingRangeProvider>;
	public readonly selectionRangeProvider: LanguageFeatureRegistry<LanguageSelectionRangeProvider>;
	public readonly documentHighlightProvider: LanguageFeatureRegistry<DocumentHighlightProvider>;
	public readonly multiDocumentHighlightProvider: LanguageFeatureRegistry<MultiDocumentHighlightProvider>;
	private _notebookTypeResolver: NotebookInfoResolver | undefined;

	constructor(languageConfigurations: ILanguageConfigurationService) {
		super();
		this.syntaxProvider = this._register(new SyntaxProviderRegistry());
		this._register(this.syntaxProvider.register(createLanguageLexicalSyntaxProvider({ languageConfigurations })));
		this.completionProvider = this._register(new LanguageCompletionProviderRegistry());
		this._register(this.completionProvider.register(createLanguageWordCompletionProvider()));
		this.codeActionProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.codeLensProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.documentSymbolProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.documentFormattingEditProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.documentRangeFormattingEditProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.onTypeFormattingEditProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.hoverProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.inlayHintsProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.inlineCompletionsProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.linkedEditingRangeProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.linkProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.signatureHelpProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.renameProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.colorProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.definitionProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.declarationProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.implementationProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.typeDefinitionProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.referenceProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.workspaceSymbolProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.callHierarchyProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.typeHierarchyProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.documentSemanticTokensProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.foldingRangeProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.selectionRangeProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.documentHighlightProvider = new LanguageFeatureRegistry(this._score.bind(this));
		this.multiDocumentHighlightProvider = new LanguageFeatureRegistry(this._score.bind(this));
	}

	public setNotebookTypeResolver(resolver: NotebookInfoResolver | undefined): void {
		this._notebookTypeResolver = resolver;
	}

	private _score(uri: URI): NotebookInfo | undefined {
		return this._notebookTypeResolver?.(uri);
	}

	public registerProviderBatch(providers: LanguageProviderBatch): LanguageProviderBatchRegistration {
		const completions = this.completionProvider.registerGroup([]);
		const hovers = new LanguageFeatureBatchRegistration(this.hoverProvider);
		const documentFormatting = new LanguageFeatureBatchRegistration(this.documentFormattingEditProvider);
		const documentRangeFormatting = new LanguageFeatureBatchRegistration(
			this.documentRangeFormattingEditProvider,
			provider => typeof provider.provideRangeFormattingEdits === 'function',
		);
		const onTypeFormatting = new LanguageFeatureBatchRegistration(
			this.onTypeFormattingEditProvider,
			provider => typeof provider.provideOnTypeFormattingEdits === 'function',
		);
		const inlayHints = new LanguageFeatureBatchRegistration(this.inlayHintsProvider);
		const linkedEditing = new LanguageFeatureBatchRegistration(this.linkedEditingRangeProvider);
		const parameterHints = new LanguageFeatureBatchRegistration(this.signatureHelpProvider);
		const registrations = {
			completions,
			hovers,
			documentFormatting,
			documentRangeFormatting,
			onTypeFormatting,
			inlayHints,
			linkedEditing,
			parameterHints,
		};
		let current = emptyProviderBatch();
		let disposed = false;
		const replace = (replacement: LanguageProviderBatch): void => {
			if (disposed) {
				throw new ReferenceError('Language provider batch registration is already disposed');
			}
			const next = normalizeProviderBatch(replacement);
			runWithBufferedEvents(() => {
				try {
					replaceProviderRegistrations(registrations, next);
				} catch (error) {
					replaceProviderRegistrations(registrations, current);
					throw error;
				}
			});
			current = next;
		};
		replace(providers);
		const registration = toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			runWithBufferedEvents(() => {
				parameterHints.dispose();
				linkedEditing.dispose();
				inlayHints.dispose();
				onTypeFormatting.dispose();
				documentRangeFormatting.dispose();
				documentFormatting.dispose();
				hovers.dispose();
				completions.dispose();
			});
		}) as LanguageProviderBatchRegistration;
		registration.replace = replace;
		return registration;
	}
}

interface LanguageProviderRegistrations {
	readonly completions: LanguageCompletionProviderRegistration;
	readonly hovers: LanguageFeatureBatchRegistration<LanguageHoverProvider>;
	readonly documentFormatting: LanguageFeatureBatchRegistration<DocumentFormattingEditProvider>;
	readonly documentRangeFormatting: LanguageFeatureBatchRegistration<LanguageFormattingProvider>;
	readonly onTypeFormatting: LanguageFeatureBatchRegistration<LanguageFormattingProvider>;
	readonly inlayHints: LanguageFeatureBatchRegistration<LanguageInlayHintsProvider>;
	readonly linkedEditing: LanguageFeatureBatchRegistration<LinkedEditingRangeProvider>;
	readonly parameterHints: LanguageFeatureBatchRegistration<LanguageParameterHintsProvider>;
}

class LanguageFeatureBatchRegistration<TProvider> implements IDisposable {
	private registrations: IDisposable[] = [];

	constructor(
		private readonly registry: LanguageFeatureRegistry<TProvider>,
		private readonly accepts: (provider: TProvider) => boolean = () => true,
	) { }

	replace(entries: readonly LanguageProviderBatchEntry<TProvider>[]): void {
		const next: IDisposable[] = [];
		try {
			for (const entry of entries) {
				if (!this.accepts(entry.provider)) continue;
				next.push(this.registry.register(entry.selector, entry.provider));
			}
		} catch (error) {
			disposeRegistrations(next);
			throw error;
		}
		const previous = this.registrations;
		this.registrations = next;
		disposeRegistrations(previous);
	}

	dispose(): void {
		const registrations = this.registrations;
		this.registrations = [];
		disposeRegistrations(registrations);
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function disposeRegistrations(registrations: readonly IDisposable[]): void {
	for (let index = registrations.length - 1; index >= 0; index -= 1) {
		registrations[index]!.dispose();
	}
}

function replaceProviderRegistrations(registrations: LanguageProviderRegistrations, providers: Required<LanguageProviderBatch>): void {
	registrations.completions.replace(providers.completions);
	registrations.hovers.replace(providers.hovers);
	registrations.documentFormatting.replace(providers.formatting.filter((entry): entry is LanguageProviderBatchEntry<DocumentFormattingEditProvider> => typeof entry.provider.provideDocumentFormattingEdits === 'function'));
	registrations.documentRangeFormatting.replace(providers.formatting);
	registrations.onTypeFormatting.replace(providers.formatting);
	registrations.inlayHints.replace(providers.inlayHints);
	registrations.linkedEditing.replace(providers.linkedEditing);
	registrations.parameterHints.replace(providers.parameterHints);
}

function normalizeProviderBatch(value: LanguageProviderBatch): Required<LanguageProviderBatch> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Language provider batch must be an object');
	}
	const record = value as Record<string, unknown>;
	const supported = new Set(['completions', 'hovers', 'formatting', 'inlayHints', 'linkedEditing', 'parameterHints']);
	if (Object.keys(record).some(key => !supported.has(key))) {
		throw new TypeError('Language provider batch contains an unsupported provider kind');
	}
	return Object.freeze({
		completions: frozenProviderArray(value.completions, 'completion'),
		hovers: frozenLanguageFeatureEntries(value.hovers, 'hover'),
		formatting: frozenLanguageFeatureEntries(value.formatting, 'formatting'),
		inlayHints: frozenLanguageFeatureEntries(value.inlayHints, 'Inlay Hints'),
		linkedEditing: frozenLanguageFeatureEntries(value.linkedEditing, 'Linked Editing'),
		parameterHints: frozenLanguageFeatureEntries(value.parameterHints, 'Parameter Hints'),
	});
}

function emptyProviderBatch(): Required<LanguageProviderBatch> {
	const empty = Object.freeze([]);
	return Object.freeze({ completions: empty, hovers: empty, formatting: empty, inlayHints: empty, linkedEditing: empty, parameterHints: empty });
}

function frozenProviderArray<T>(value: readonly T[] | undefined, owner: string): readonly T[] {
	if (value === undefined) {
		return Object.freeze([]);
	}
	if (!Array.isArray(value)) {
		throw new TypeError(`Language ${owner} providers must be an array`);
	}
	return Object.freeze([...value]);
}

function frozenLanguageFeatureEntries<TProvider>(value: readonly LanguageProviderBatchEntry<TProvider>[] | undefined, owner: string): readonly LanguageProviderBatchEntry<TProvider>[] {
	const entries = frozenProviderArray(value, owner);
	return Object.freeze(entries.map(entry => {
		if (!entry || typeof entry !== 'object' || !('selector' in entry) || !entry.provider || typeof entry.provider !== 'object') {
			throw new TypeError(`Language ${owner} provider entry must contain a selector and provider`);
		}
		return Object.freeze({ selector: entry.selector, provider: entry.provider });
	}));
}

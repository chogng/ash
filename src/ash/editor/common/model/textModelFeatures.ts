import type { ITextEditingPolicy } from '../cursor/textEditingPolicy.js';
import { CallbackIterable } from '../../../base/common/arrays.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, markAsSingleton, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { StandardTokenType } from '../encodedTokenAttributes.js';
import { BackgroundTokenizationState } from '../tokenizationTextModelPart.js';
import { LineTokens } from '../tokens/lineTokens.js';
import { createLanguageDiagnosticStore } from './languageResultStore.js';
import type { TextModel, TextModelOptions } from './textModel.js';
import type { DecorationProvider } from './decorationProvider.js';
import type { IRange } from '../core/range.js';
import type { SemanticTokenSource } from '../tokens/languageTokens.js';

export type { TextModelTokenizationOptions } from '../tokenizationTextModelPart.js';
import type { IModelTokenization } from '../tokenizationTextModelPart.js';
import type { IBracketPairsTextModelPart } from '../textModelBracketPairs.js';
import type { IGuidesTextModelPart } from '../textModelGuides.js';
import type { LanguageConfigurationServiceChangeEvent } from '../languages/languageConfigurationRegistry.js';
import type { IModelOptionsChangedEvent, IModelLanguageChangedEvent, IModelContentChangedEvent, IModelTokensChangedEvent } from '../textModelEvents.js';

interface ModelBracketPairs extends IBracketPairsTextModelPart, IDisposable {
	handleLanguageConfigurationServiceChange(event: LanguageConfigurationServiceChangeEvent): void;
	handleDidChangeOptions(event: IModelOptionsChangedEvent): void;
	handleDidChangeLanguage(event: IModelLanguageChangedEvent): void;
	handleDidChangeContent(event: IModelContentChangedEvent): void;
	handleDidChangeTokens(event: IModelTokensChangedEvent): void;
	handleDidChangeBackgroundTokenizationState(): void;
}
export interface TextModelFeatureParts extends IDisposable {
	readonly editingPolicy?: ITextEditingPolicy;
	readonly brackets: ModelBracketPairs;
	readonly guides: IGuidesTextModelPart & IDisposable;
	readonly tokenization: IModelTokenization;
	readonly diagnostics: {
		readonly onDidEncounterError: Event<unknown>;
		readonly results: ReturnType<typeof createLanguageDiagnosticStore>;
	};
	readonly decorations: DecorationProvider & { readonly onDidChange: Event<void> };
}
export type TextModelFeatureFactory = (model: TextModel, options: TextModelOptions) => TextModelFeatureParts | undefined;
const changes = markAsSingleton(new Emitter<void>());
let factory: TextModelFeatureFactory | undefined;

/** One admitted owner supplies optional model analysis. Text, versions and undo remain in TextModel. */
export function registerTextModelFeatures(value: TextModelFeatureFactory): IDisposable {
	if (factory) throw new Error('Text model features already have a provider');
	factory = value;
	changes.fire();
	return toDisposable(() => {
		if (factory === value) {
			factory = undefined;
			changes.fire();
		}
	});
}

/** Keeps view-facing event and token-source identities stable across provider arrival and retirement. */
export class TextModelFeatureHost extends Disposable {
	private readonly active = this._register(new DisposableStore());
	private parts: TextModelFeatureParts;
	private readonly tokensChanged = this._register(new Emitter<readonly { fromLineNumber: number; toLineNumber: number }[] | undefined>());
	private readonly stylesChanged = this._register(new Emitter<void>());
	private readonly bracketsChanged = this._register(new Emitter<void>());
	private readonly decorationsChanged = this._register(new Emitter<void>());
	readonly onDidChangeDecorations = this.decorationsChanged.event;
	readonly brackets: TextModelFeatureParts['brackets'];
	readonly guides: TextModelFeatureParts['guides'];
	readonly tokenization: TextModelFeatureParts['tokenization'];
	get diagnostics() {
		return this.parts.diagnostics;
	}
	get editingPolicy() {
		return this.parts.editingPolicy;
	}
	get decorations() {
		return this.parts.decorations;
	}

	constructor(
		private readonly model: TextModel,
		private readonly options: TextModelOptions,
	) {
		super();
		this.parts = this.active.add(plainFeatures(model));
		const host = this;
		const renderedTokens: SemanticTokenSource = {
			textModel: model,
			onDidChange: this.stylesChanged.event,
			get lines() {
				return host.parts.tokenization.renderedTokens.lines;
			},
			getLineTokens: line => host.parts.tokenization.renderedTokens.getLineTokens(line),
		};
		const languageTokens: TextModelFeatureParts['tokenization']['languageTokens'] = {
			textModel: model,
			onDidChange: listener => this.tokensChanged.event(() => listener()),
			get modelVersion() {
				return model.getVersionId();
			},
			get lines() {
				return host.parts.tokenization.languageTokens.lines;
			},
			getLineTokens: line => host.parts.tokenization.languageTokens.getLineTokens(line),
		};
		this.brackets = delegate(() => this.parts.brackets, { onDidChange: this.bracketsChanged.event });
		this.guides = delegate(() => this.parts.guides, {});
		this.tokenization = delegate(() => this.parts.tokenization, {
			onDidChange: this.tokensChanged.event,
			renderedTokens,
			languageTokens,
		});
		this._register(changes.event(() => this.refresh()));
	}

	initialize(): void {
		this.refresh();
	}

	private refresh(): void {
		this.active.clear();
		this.parts = this.active.add(plainFeatures(this.model));
		if (factory) {
			const created = factory(this.model, this.options);
			if (!created) {
				this.tokensChanged.fire(undefined);
				this.stylesChanged.fire();
				this.bracketsChanged.fire();
				this.decorationsChanged.fire();
				return;
			}
			const parts = this.active.add(created);
			this.parts = parts;
			this.active.add(parts.tokenization.onDidChange(ranges => this.tokensChanged.fire(ranges)));
			this.active.add(parts.tokenization.renderedTokens.onDidChange(() => this.stylesChanged.fire()));
			this.active.add(parts.brackets.onDidChange(() => this.bracketsChanged.fire()));
			this.active.add(parts.decorations.onDidChange(() => this.decorationsChanged.fire()));
			this.active.add(this.model.onDidChangeLanguage(event => parts.brackets.handleDidChangeLanguage(event)));
			this.active.add(this.model.onDidChangeOptions(event => parts.brackets.handleDidChangeOptions(event)));
			if (this.options.languageConfigurationService)
				this.active.add(this.options.languageConfigurationService.onDidChange(event => parts.brackets.handleLanguageConfigurationServiceChange(event)));
		}
		this.tokensChanged.fire(undefined);
		this.stylesChanged.fire();
		this.bracketsChanged.fire();
		this.decorationsChanged.fire();
	}
}

function delegate<T extends object>(get: () => T, stable: Partial<T>): T {
	return new Proxy(stable as T, {
		get(target, key) {
			if (Object.prototype.hasOwnProperty.call(target, key)) return Reflect.get(target, key);
			const part = get();
			const value = Reflect.get(part, key);
			return typeof value === 'function' ? value.bind(part) : value;
		},
	});
}

function plainFeatures(model: TextModel): TextModelFeatureParts {
	const resources = new DisposableStore();
	const empty = () => {};
	const emptyTokens = { textModel: model, onDidChange: Event.None, lines: [], getLineTokens: () => [] };
	const codec = { encodeLanguageId: () => 1, decodeLanguageId: () => model.getLanguageId() };
	const tokenization: TextModelFeatureParts['tokenization'] = {
		dispose: empty,
		[Symbol.dispose]: empty,
		textModel: model,
		onDidChange: Event.None,
		onDidEncounterError: Event.None,
		get modelVersion() {
			return model.getVersionId();
		},
		tokenCount: 0,
		lines: [],
		languageTokens: {
			...emptyTokens,
			get modelVersion() {
				return model.getVersionId();
			},
		},
		renderedTokens: emptyTokens,
		semanticTokens: undefined,
		syntaxTree: undefined,
		hasTokens: false,
		setSemanticTokens: empty,
		setPartialSemanticTokens: empty,
		hasCompleteSemanticTokens: () => false,
		hasSomeSemanticTokens: () => false,
		resetTokenization: empty,
		whenReady: async signal => signal.throwIfAborted(),
		forceTokenization: empty,
		tokenizeIfCheap: empty,
		hasAccurateTokensForLine: () => true,
		isCheapToTokenize: () => true,
		getLineTokens: line => LineTokens.createEmpty(model.getLineContent(line), codec),
		getLanguageTokens: () => [],
		getTokenTypeIfInsertingCharacter: () => StandardTokenType.Other,
		tokenizeLinesAt: () => null,
		tokenizeLinesAtAsync: async (_line, _lines, signal) => {
			signal.throwIfAborted();
			return null;
		},
		getLanguageId: () => model.getLanguageId(),
		getLanguageIdAtPosition: () => model.getLanguageId(),
		setLanguageId: language => model.setLanguage(language),
		backgroundTokenizationState: BackgroundTokenizationState.Completed,
		setVisibleLines: empty,
	};
	return Object.assign(resources, {
		tokenization,
		brackets: {
			dispose: empty,
			[Symbol.dispose]: empty,
			onDidChange: Event.None,
			handleLanguageConfigurationServiceChange: empty,
			handleDidChangeOptions: empty,
			handleDidChangeLanguage: empty,
			handleDidChangeContent: empty,
			handleDidChangeTokens: empty,
			handleDidChangeBackgroundTokenizationState: empty,
			getBracketPairsInRange: () => CallbackIterable.empty,
			getBracketPairsInRangeWithMinIndentation: () => CallbackIterable.empty,
			getBracketsInRange: () => CallbackIterable.empty,
			findMatchingBracketUp: () => null,
			findPrevBracket: () => null,
			findNextBracket: () => null,
			findEnclosingBrackets: () => null,
			matchBracket: () => null,
		},
		guides: {
			dispose: empty,
			[Symbol.dispose]: empty,
			getActiveIndentGuide: (line: number) => ({ startLineNumber: line, endLineNumber: line, indent: 0 }),
			getLinesIndentGuides: (start: number, end: number) => Array.from({ length: end - start + 1 }, () => 0),
			getLinesBracketGuides: (start: number, end: number) => Array.from({ length: end - start + 1 }, () => []),
		},
		decorations: { onDidChange: Event.None, getDecorationsInRange: (_range: IRange) => [] },
		diagnostics: { onDidEncounterError: Event.None, results: resources.add(createLanguageDiagnosticStore(model)) },
	});
}

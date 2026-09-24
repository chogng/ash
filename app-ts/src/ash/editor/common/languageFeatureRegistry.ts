import { Emitter, type Event } from '../../base/common/event.js';
import { type IDisposable, toDisposable, Disposable } from '../../base/common/lifecycle.js';
import { type ITextModel } from './model.js';
import { type LanguageFilter, type LanguageSelector, score, selectLanguageIds } from './languageSelector.js';
import { type URI } from '../../base/common/uri.js';
import { isNonEmptyArray } from '../../base/common/arrays.js';
import { assertLanguageId } from './languages/language.js';
import { type LanguageCompletionContext, type LanguageCompletionProvider, type LanguageCompletionProviderCatalog, type LanguageCompletionProviderCatalogSource, type RegisteredLanguageCompletionProvider, type LanguageCompletionProviderRegistration, languageCompletionProviderMatches, assertLanguageCompletionContext, assertLanguageProviderId, normalizeCompletionProvider, type SyntaxProvider, type RegisteredSyntaxProvider, normalizeSyntaxProvider } from './languages.js';

interface Entry<T> {
	readonly selector: LanguageSelector;
	readonly provider: T;
	_score: number;
	readonly _time: number;
}

function isExclusive(selector: LanguageSelector): boolean {
	if (typeof selector === 'string') {
		return false;
	} else if (Array.isArray(selector)) {
		return selector.every(isExclusive);
	} else {
		return !!(selector as LanguageFilter).exclusive;
	}
}

export interface NotebookInfo {
	readonly uri: URI;
	readonly type: string;
}

export interface NotebookInfoResolver {
	(uri: URI): NotebookInfo | undefined;
}

class MatchCandidate {
	constructor(
		readonly uri: URI,
		readonly languageId: string,
		readonly notebookUri: URI | undefined,
		readonly notebookType: string | undefined,
		readonly recursive: boolean,
	) { }

	equals(other: MatchCandidate): boolean {
		return this.notebookType === other.notebookType
			&& this.languageId === other.languageId
			&& this.uri.toString() === other.uri.toString()
			&& this.notebookUri?.toString() === other.notebookUri?.toString()
			&& this.recursive === other.recursive;
	}
}

export class LanguageFeatureRegistry<T> {
	private _clock = 0;
	private readonly _entries: Entry<T>[] = [];

	private readonly _onDidChange = new Emitter<number>();
	get onDidChange() { return this._onDidChange.event; }

	constructor(private readonly _notebookInfoResolver?: NotebookInfoResolver) { }

	register(selector: LanguageSelector, provider: T): IDisposable {
		let entry: Entry<T> | undefined = {
			selector,
			provider,
			_score: -1,
			_time: this._clock++,
		};

		this._entries.push(entry);
		this._lastCandidate = undefined;
		this._onDidChange.fire(this._entries.length);

		return toDisposable(() => {
			if (entry) {
				const index = this._entries.indexOf(entry);
				if (index >= 0) {
					this._entries.splice(index, 1);
					this._lastCandidate = undefined;
					this._onDidChange.fire(this._entries.length);
					entry = undefined;
				}
			}
		});
	}

	has(model: ITextModel): boolean {
		return this.all(model).length > 0;
	}

	all(model: ITextModel): T[] {
		if (!model) {
			return [];
		}

		this._updateScores(model, false);
		const result: T[] = [];
		for (const entry of this._entries) {
			if (entry._score > 0) {
				result.push(entry.provider);
			}
		}
		return result;
	}

	allNoModel(): T[] {
		return this._entries.map(entry => entry.provider);
	}

	get registeredLanguageIds(): ReadonlySet<string> {
		const result = new Set<string>();
		for (const entry of this._entries) {
			selectLanguageIds(entry.selector, result);
		}
		return result;
	}

	ordered(model: ITextModel, recursive = false): T[] {
		const result: T[] = [];
		this._orderedForEach(model, recursive, entry => result.push(entry.provider));
		return result;
	}

	orderedGroups(model: ITextModel): T[][] {
		const result: T[][] = [];
		let lastBucket: T[];
		let lastBucketScore: number;

		this._orderedForEach(model, false, entry => {
			if (lastBucket && lastBucketScore === entry._score) {
				lastBucket.push(entry.provider);
			} else {
				lastBucketScore = entry._score;
				lastBucket = [entry.provider];
				result.push(lastBucket);
			}
		});

		return result;
	}

	private _orderedForEach(model: ITextModel, recursive: boolean, callback: (provider: Entry<T>) => void): void {
		this._updateScores(model, recursive);
		for (const entry of this._entries) {
			if (entry._score > 0) {
				callback(entry);
			}
		}
	}

	private _lastCandidate: MatchCandidate | undefined;

	private _updateScores(model: ITextModel, recursive: boolean): void {
		const notebookInfo = this._notebookInfoResolver?.(model.uri);
		const candidate = notebookInfo
			? new MatchCandidate(model.uri, model.getLanguageId(), notebookInfo.uri, notebookInfo.type, recursive)
			: new MatchCandidate(model.uri, model.getLanguageId(), undefined, undefined, recursive);

		if (this._lastCandidate?.equals(candidate)) {
			return;
		}

		this._lastCandidate = candidate;

		for (const entry of this._entries) {
			entry._score = score(entry.selector, candidate.uri, candidate.languageId, shouldSynchronizeModel(model), candidate.notebookUri, candidate.notebookType);

			if (isExclusive(entry.selector) && entry._score > 0) {
				if (recursive) {
					entry._score = 0;
				} else {
					for (const entry of this._entries) {
						entry._score = 0;
					}
					entry._score = 1000;
					break;
				}
			}
		}

		this._entries.sort(LanguageFeatureRegistry._compareByScoreAndTime);
	}

	private static _compareByScoreAndTime(a: Entry<unknown>, b: Entry<unknown>): number {
		if (a._score < b._score) {
			return 1;
		} else if (a._score > b._score) {
			return -1;
		}

		if (isBuiltinSelector(a.selector) && !isBuiltinSelector(b.selector)) {
			return 1;
		} else if (!isBuiltinSelector(a.selector) && isBuiltinSelector(b.selector)) {
			return -1;
		}

		if (a._time < b._time) {
			return 1;
		} else if (a._time > b._time) {
			return -1;
		}
		return 0;
	}
}

function shouldSynchronizeModel(model: ITextModel): boolean {
	return !model.isTooLargeForSyncing() && !model.isForSimpleWidget;
}

function isBuiltinSelector(selector: LanguageSelector): boolean {
	if (typeof selector === 'string') {
		return false;
	}
	if (Array.isArray(selector)) {
		return selector.some(isBuiltinSelector);
	}
	return Boolean((selector as LanguageFilter).isBuiltin);
}

interface OwnedLanguageCompletionProvider {
	readonly owner: object;
	readonly provider: RegisteredLanguageCompletionProvider;
}

/** Caller-owned registry with deterministic registration-order provider lookup. */
export class LanguageCompletionProviderRegistry extends Disposable implements LanguageCompletionProviderCatalogSource {
	private readonly catalogEmitter = this._register(new Emitter<LanguageCompletionProviderCatalog>());
	private readonly providers = new Map<string, OwnedLanguageCompletionProvider>();
	private catalog: LanguageCompletionProviderCatalog = EMPTY_PROVIDER_CATALOG;

	readonly onDidChangeProviderCatalog: Event<LanguageCompletionProviderCatalog> = this.catalogEmitter.event;
	readonly providerCatalogReady = true;

	constructor(private readonly parent?: LanguageCompletionProviderRegistry) {
		super();
		if (parent) {
			this._register(parent.onDidChangeProviderCatalog(() => this.updateCatalog()));
			this.updateCatalog();
		}
		this._register(toDisposable(() => {
			this.providers.clear();
		}));
	}

	register(provider: LanguageCompletionProvider): IDisposable {
		return this.registerMany([provider]);
	}

	registerMany(providers: readonly LanguageCompletionProvider[]): IDisposable {
		this.assertNotDisposed();
		if (!isNonEmptyArray(providers)) {
			throw new TypeError("Language completion provider batch must not be empty");
		}
		return this.registerGroup(providers);
	}

	registerGroup(providers: readonly LanguageCompletionProvider[]): LanguageCompletionProviderRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replace(owner, providers);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			if (this.deleteOwner(owner) && !this.isDisposed) this.updateCatalog();
		}) as LanguageCompletionProviderRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Language completion provider registration is already disposed");
			this.assertNotDisposed();
			this.replace(owner, replacement);
		};
		return registration;
	}

	get providerCatalog(): LanguageCompletionProviderCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	waitForProviderCatalog(): Promise<LanguageCompletionProviderCatalog> {
		return Promise.resolve(this.providerCatalog);
	}

	getProviders(languageId: string, context: LanguageCompletionContext): readonly RegisteredLanguageCompletionProvider[] {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		assertLanguageCompletionContext(context);
		const result = [...this.providers.values()].map(entry => entry.provider).filter(provider => languageCompletionProviderMatches(provider, languageId, context));
		return Object.freeze([...result, ...(this.parent?.getProviders(languageId, context).filter(provider => !this.providers.has(provider.id)) ?? [])]);
	}

	getProvider(providerId: string): RegisteredLanguageCompletionProvider | undefined {
		this.assertNotDisposed();
		assertLanguageProviderId(providerId, "Language completion provider ID");
		return this.providers.get(providerId)?.provider ?? this.parent?.getProvider(providerId);
	}

	private updateCatalog(): void {
		const providers = Object.freeze([...this.providers.values()].map(entry => entry.provider).map(provider => Object.freeze({
			id: provider.id,
			languageIds: provider.languageIds,
			triggerCharacters: provider.triggerCharacters,
		})));
		this.catalog = Object.freeze({
			revision: this.catalog.revision + 1,
			providers: Object.freeze([...providers, ...(this.parent?.providerCatalog.providers.filter(provider => !this.providers.has(provider.id)) ?? [])]),
		});
		this.catalogEmitter.fire(this.catalog);
	}

	private replace(owner: object, providers: readonly LanguageCompletionProvider[]): void {
		if (!Array.isArray(providers)) throw new TypeError("Language completion providers must be an array");
		const registered = providers.map(normalizeCompletionProvider);
		const identities = new Set<string>();
		for (const provider of registered) {
			const existing = this.providers.get(provider.id);
			if (identities.has(provider.id) || existing && existing.owner !== owner) throw new RangeError(`Language completion provider '${provider.id}' is already registered`);
			identities.add(provider.id);
		}
		this.deleteOwner(owner);
		for (const provider of registered) this.providers.set(provider.id, { owner, provider });
		this.updateCatalog();
	}

	private deleteOwner(owner: object): boolean {
		let changed = false;
		for (const [id, entry] of this.providers) {
			if (entry.owner !== owner) continue;
			this.providers.delete(id);
			changed = true;
		}
		return changed;
	}
}

const EMPTY_PROVIDER_CATALOG: LanguageCompletionProviderCatalog = Object.freeze({
	revision: 0,
	providers: Object.freeze([]),
});

/** Caller-owned registry for snapshot tokenization and diagnostic providers. */
export class SyntaxProviderRegistry extends Disposable {
	private readonly providers = new Map<string, RegisteredSyntaxProvider>();
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.providers.clear();
		}));
	}

	register(provider: SyntaxProvider): IDisposable {
		return this.registerMany([provider]);
	}

	registerMany(providers: readonly SyntaxProvider[]): IDisposable {
		this.assertNotDisposed();
		if (!isNonEmptyArray(providers)) {
			throw new TypeError("Syntax provider batch must not be empty");
		}
		const registered = providers.map(normalizeSyntaxProvider);
		const identities = new Set<string>();
		for (const provider of registered) {
			if (identities.has(provider.id) || this.providers.has(provider.id)) {
				throw new RangeError(`Syntax provider '${provider.id}' is already registered`);
			}
			identities.add(provider.id);
		}
		for (const provider of registered) this.providers.set(provider.id, provider);
		this.changeEmitter.fire();
		return toDisposable(() => {
			let changed = false;
			for (const provider of registered) {
				if (this.providers.get(provider.id) === provider) {
					this.providers.delete(provider.id);
					changed = true;
				}
			}
			if (changed) this.changeEmitter.fire();
		});
	}

	getTokenProvider(languageId: string): RegisteredSyntaxProvider | undefined {
		return this.getTokenProviders(languageId)[0];
	}

	getTokenProviders(languageId: string): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		const selected: RegisteredSyntaxProvider[] = [];
		for (const provider of this.providers.values()) {
			if (!provider.provideTokens || !matchesLanguage(provider, languageId)) continue;
			const index = selected.findIndex(candidate => provider.tokenPriority > candidate.tokenPriority);
			if (index < 0) selected.push(provider);
			else selected.splice(index, 0, provider);
		}
		return Object.freeze(selected);
	}

	getDiagnosticProviders(languageId: string): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		const selected = [...this.providers.values()]
			.filter(provider => provider.provideDiagnostics && matchesLanguage(provider, languageId))
			.sort((left, right) => right.diagnosticPriority - left.diagnosticPriority);
		if (selected.length === 0) return Object.freeze([]);
		const priority = selected[0]!.diagnosticPriority;
		return Object.freeze(selected.filter(provider => provider.diagnosticPriority === priority));
	}

	getDocumentSynchronizers(): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		return Object.freeze([...this.providers.values()].filter(provider => provider.synchronizeDocument));
	}

}



function matchesLanguage(provider: RegisteredSyntaxProvider, languageId: string): boolean {
	return provider.languageIds.includes("*") || provider.languageIds.includes(languageId);
}

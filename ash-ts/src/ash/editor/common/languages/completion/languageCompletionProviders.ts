import { isNonEmptyArray } from "../../../../base/common/arrays.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type LanguageCompletionCommand, type LanguageCompletionItem, type LanguageCompletionItemDetails, type LanguageCompletionResult } from "./languageCompletions.js";
import { assertLanguageId } from '../language.js';
import { assertLanguageSelector } from '../../languageSelector.js';
import { type Position } from "../../core/position.js";
import { type TextSnapshot } from "../../core/textChange.js";
import { type URI } from "../../../../base/common/uri.js";

export enum LanguageCompletionTriggerKind {
	Invoke = "invoke",
	TriggerCharacter = "triggerCharacter",
	IncompleteRefresh = "incompleteRefresh",
}

export interface LanguageCompletionInvokeContext {
	readonly kind: LanguageCompletionTriggerKind.Invoke;
}

export interface LanguageCompletionTriggerCharacterContext {
	readonly kind: LanguageCompletionTriggerKind.TriggerCharacter;
	readonly triggerCharacter: string;
}

export interface LanguageCompletionIncompleteRefreshContext {
	readonly kind: LanguageCompletionTriggerKind.IncompleteRefresh;
}

export type LanguageCompletionContext = LanguageCompletionInvokeContext | LanguageCompletionTriggerCharacterContext | LanguageCompletionIncompleteRefreshContext;

export interface LanguageCompletionRequest {
	readonly languageId: string;
	readonly resource?: URI;
	readonly position: Position;
	readonly context: LanguageCompletionContext;
}

export interface LanguageCompletionProviderRequest extends LanguageCompletionRequest {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
}

export type LanguageCompletionProviderItem = Omit<LanguageCompletionItem, "providerId" | "hasDeferredDetails"> & {
	readonly resolveData?: unknown;
};

export interface LanguageCompletionProviderResolveRequest {
	readonly completionRequestId: number;
	readonly modelVersion: number;
	readonly item: LanguageCompletionProviderItem;
}

export interface LanguageCompletionProviderCommandRequest {
	readonly languageId: string;
	readonly resource?: URI;
	readonly snapshot: TextSnapshot;
	readonly command: LanguageCompletionCommand;
}

export interface LanguageCompletionProviderResult {
	readonly items: readonly LanguageCompletionProviderItem[];
	readonly isIncomplete: boolean;
}

export interface LanguageCompletionProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly triggerCharacters?: readonly string[];
	provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined | PromiseLike<LanguageCompletionProviderResult | undefined>;
	resolveCompletionItem?(request: LanguageCompletionProviderResolveRequest, signal: AbortSignal): LanguageCompletionItemDetails | undefined | PromiseLike<LanguageCompletionItemDetails | undefined>;
	executeCompletionCommand?(request: LanguageCompletionProviderCommandRequest, signal: AbortSignal): void | PromiseLike<void>;
}

export interface LanguageCompletionProviderMetadata {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly triggerCharacters: readonly string[];
}

export interface LanguageCompletionProviderCatalog {
	readonly revision: number;
	readonly providers: readonly LanguageCompletionProviderMetadata[];
}

export interface LanguageCompletionProviderCatalogSource {
	readonly providerCatalog: LanguageCompletionProviderCatalog;
	readonly providerCatalogReady: boolean;
	readonly onDidChangeProviderCatalog: Event<LanguageCompletionProviderCatalog>;
	waitForProviderCatalog(): Promise<LanguageCompletionProviderCatalog>;
}

export interface RegisteredLanguageCompletionProvider extends LanguageCompletionProviderMetadata {
	provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined | PromiseLike<LanguageCompletionProviderResult | undefined>;
	resolveCompletionItem?(request: LanguageCompletionProviderResolveRequest, signal: AbortSignal): LanguageCompletionItemDetails | undefined | PromiseLike<LanguageCompletionItemDetails | undefined>;
	executeCompletionCommand?(request: LanguageCompletionProviderCommandRequest, signal: AbortSignal): void | PromiseLike<void>;
}

/** One caller-owned provider set that can be atomically replaced. */
export interface LanguageCompletionProviderRegistration extends IDisposable {
	replace(providers: readonly LanguageCompletionProvider[]): void;
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
		assertCompletionContext(context);
		const result = [...this.providers.values()].map(entry => entry.provider).filter(provider => languageCompletionProviderMatches(provider, languageId, context));
		return Object.freeze([...result, ...(this.parent?.getProviders(languageId, context).filter(provider => !this.providers.has(provider.id)) ?? [])]);
	}

	getProvider(providerId: string): RegisteredLanguageCompletionProvider | undefined {
		this.assertNotDisposed();
		assertIdentifier(providerId, "Language completion provider ID");
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
		const registered = providers.map(normalizeProvider);
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

export function createLanguageCompletionInvokeContext(): LanguageCompletionInvokeContext {
	return INVOKE_CONTEXT;
}

export function createLanguageCompletionTriggerCharacterContext(triggerCharacter: string): LanguageCompletionTriggerCharacterContext {
	assertTriggerCharacter(triggerCharacter);
	return Object.freeze({
		kind: LanguageCompletionTriggerKind.TriggerCharacter,
		triggerCharacter,
	});
}

export function createLanguageCompletionIncompleteRefreshContext(): LanguageCompletionIncompleteRefreshContext {
	return INCOMPLETE_REFRESH_CONTEXT;
}

export function assertLanguageCompletionRequest(request: LanguageCompletionRequest): void {
	if (typeof request !== "object" || request === null) {
		throw new TypeError("Language completion request must be an object");
	}
	assertLanguageId(request.languageId);
	if (request.resource !== undefined && typeof request.resource.toString !== "function") throw new TypeError("Language completion resource must be a URI");
	assertCompletionContext(request.context);
}

export function languageCompletionProviderMatches(provider: LanguageCompletionProviderMetadata, languageId: string, context: LanguageCompletionContext): boolean {
	assertProviderMetadata(provider);
	assertLanguageId(languageId);
	assertCompletionContext(context);
	return (
		provider.languageIds.includes("*") ||
		provider.languageIds.includes(languageId)
	) && (
		context.kind !== LanguageCompletionTriggerKind.TriggerCharacter ||
		provider.triggerCharacters.includes(context.triggerCharacter)
	);
}

export function normalizeLanguageCompletionProviderCatalog(value: unknown): LanguageCompletionProviderCatalog {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Language completion provider catalog must be an object");
	}
	const catalog = value as Partial<LanguageCompletionProviderCatalog>;
	if (!Number.isSafeInteger(catalog.revision) || catalog.revision! < 0) {
		throw new RangeError("Language completion provider catalog revision must be a non-negative safe integer");
	}
	if (!Array.isArray(catalog.providers)) {
		throw new TypeError("Language completion provider catalog must contain providers");
	}
	const identities = new Set<string>();
	const providers = catalog.providers.map(provider => {
		assertProviderMetadata(provider);
		if (identities.has(provider.id)) {
			throw new RangeError(`Duplicate language completion provider metadata '${provider.id}'`);
		}
		identities.add(provider.id);
		if (new Set(provider.languageIds).size !== provider.languageIds.length) {
			throw new RangeError(`Language completion provider '${provider.id}' language IDs must be unique`);
		}
		if (new Set(provider.triggerCharacters).size !== provider.triggerCharacters.length) {
			throw new RangeError(`Language completion provider '${provider.id}' trigger characters must be unique`);
		}
		return Object.freeze({
			id: provider.id,
			languageIds: Object.freeze([...provider.languageIds]),
			triggerCharacters: Object.freeze([...provider.triggerCharacters]),
		});
	});
	return Object.freeze({
		revision: catalog.revision!,
		providers: Object.freeze(providers),
	});
}

const INVOKE_CONTEXT = Object.freeze({
	kind: LanguageCompletionTriggerKind.Invoke,
});

const INCOMPLETE_REFRESH_CONTEXT = Object.freeze({
	kind: LanguageCompletionTriggerKind.IncompleteRefresh,
});

const EMPTY_PROVIDER_CATALOG: LanguageCompletionProviderCatalog = Object.freeze({
	revision: 0,
	providers: Object.freeze([]),
});

function normalizeProvider(provider: LanguageCompletionProvider): RegisteredLanguageCompletionProvider {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Language completion provider must be an object");
	}
	assertIdentifier(provider.id, "Language completion provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Language completion provider must declare language IDs");
	}
	const languageIds = provider.languageIds.map(languageId => {
		assertLanguageSelector(languageId);
		return languageId;
	});
	if (new Set(languageIds).size !== languageIds.length) {
		throw new RangeError("Language completion provider language IDs must be unique");
	}
	const triggerCharacters = [...(provider.triggerCharacters ?? [])];
	for (const character of triggerCharacters) assertTriggerCharacter(character);
	if (new Set(triggerCharacters).size !== triggerCharacters.length) {
		throw new RangeError("Language completion provider trigger characters must be unique");
	}
	if (typeof provider.provideCompletions !== "function") {
		throw new TypeError("Language completion provider must implement provideCompletions");
	}
	if (provider.resolveCompletionItem !== undefined && typeof provider.resolveCompletionItem !== "function") {
		throw new TypeError("Language completion provider resolveCompletionItem must be a function");
	}
	if (provider.executeCompletionCommand !== undefined && typeof provider.executeCompletionCommand !== "function") throw new TypeError("Language completion provider executeCompletionCommand must be a function");
	return Object.freeze({
		id: provider.id,
		languageIds: Object.freeze(languageIds),
		triggerCharacters: Object.freeze(triggerCharacters),
		provideCompletions: provider.provideCompletions.bind(provider),
		...(provider.resolveCompletionItem === undefined ? {} : { resolveCompletionItem: provider.resolveCompletionItem.bind(provider) }),
		...(provider.executeCompletionCommand === undefined ? {} : { executeCompletionCommand: provider.executeCompletionCommand.bind(provider) }),
	});
}

function assertProviderMetadata(provider: LanguageCompletionProviderMetadata): void {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Language completion provider metadata must be an object");
	}
	assertIdentifier(provider.id, "Language completion provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Language completion provider metadata must declare language IDs");
	}
	for (const languageId of provider.languageIds) assertLanguageSelector(languageId);
	if (!Array.isArray(provider.triggerCharacters)) {
		throw new TypeError("Language completion provider metadata trigger characters must be an array");
	}
	for (const character of provider.triggerCharacters) assertTriggerCharacter(character);
}

function assertCompletionContext(context: LanguageCompletionContext): void {
	if (typeof context !== "object" || context === null) {
		throw new TypeError("Language completion context must be an object");
	}
	if (context.kind === LanguageCompletionTriggerKind.TriggerCharacter) {
		assertTriggerCharacter(context.triggerCharacter);
		return;
	}
	if (
		context.kind !== LanguageCompletionTriggerKind.Invoke &&
		context.kind !== LanguageCompletionTriggerKind.IncompleteRefresh
	) {
		throw new TypeError(`Unknown language completion trigger kind '${(context as LanguageCompletionContext).kind}'`);
	}
}

function assertIdentifier(value: unknown, owner: string): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
	) {
		throw new TypeError(`${owner} must contain only letters, digits, dot, underscore, or hyphen`);
	}
}

function assertTriggerCharacter(value: unknown): asserts value is string {
	if (typeof value !== "string" || [...value].length !== 1) {
		throw new TypeError("Language completion trigger character must contain one Unicode code point");
	}
}

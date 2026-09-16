import { raceCancellationError } from "../../../../base/common/async.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { LanguageRequestCoordinator, type LanguageRequestOptions, type LanguageRequestOutcome, type LanguageWorker, type LanguageWorkerRequest } from "../languageRequestCoordinator.js";
import { LanguageResultAcceptance } from "../languageResultStore.js";
import { createLanguageCompletionSnapshotNormalizer, createLanguageCompletionStore, normalizeLanguageCompletionItemDetails, normalizeLanguageCompletionResolveRequest, type LanguageCompletionItem, type LanguageCompletionItemDetails, type LanguageCompletionItemResolver, type LanguageCompletionResolveRequest, type LanguageCompletionResult, type LanguageCompletionResultNormalizer } from "./languageCompletions.js";
import { assertLanguageCompletionRequest, createLanguageCompletionTriggerCharacterContext, languageCompletionProviderMatches, LanguageCompletionProviderRegistry, type LanguageCompletionProvider, type LanguageCompletionProviderCatalog, type LanguageCompletionProviderCatalogSource, type LanguageCompletionProviderItem, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult, type LanguageCompletionRequest, type RegisteredLanguageCompletionProvider } from "./languageCompletionProviders.js";
import { assertLanguageId } from "../languageId.js";
import { type Position } from "../../core/position.js";
import { type TextModel } from "../../model/textModel.js";
import { URI } from "../../../../base/common/uri.js";

export const LANGUAGE_COMPLETION_LANE = "completion";
export type LanguageCompletionLane = typeof LANGUAGE_COMPLETION_LANE;
export type LanguageCompletionProviderErrorHandler = (providerId: string, error: unknown) => void;
export type LanguageCompletionWorker = LanguageWorker<LanguageCompletionLane, LanguageCompletionRequest, LanguageCompletionResult>;
export type LanguageCompletionWorkerFactory = () => LanguageCompletionWorker;

export interface LanguageCompletionServiceOptions {
	readonly onProviderError?: LanguageCompletionProviderErrorHandler;
	readonly resource?: URI;
	readonly workerFactory?: LanguageCompletionWorkerFactory;
	readonly providers?: readonly LanguageCompletionProvider[];
}

/**
 * Connects completion providers to the versioned request/result boundary.
 *
 * The service owns its coordinator, provider host instances, and result store.
 * It observes but does not own the provider registry or text model.
 */
export class LanguageCompletionService extends Disposable implements LanguageCompletionItemResolver {
	private readonly catalogEmitter = this._register(new Emitter<LanguageCompletionProviderCatalog>());
	private readonly catalogSubscription = this._register(new MutableDisposable<IDisposable>());
	readonly results: ReturnType<typeof createLanguageCompletionStore>;
	private readonly coordinator: LanguageRequestCoordinator<LanguageCompletionLane, LanguageCompletionRequest, LanguageCompletionResult>;
	private readonly registry: LanguageCompletionProviderRegistry;
	private catalogSource: LanguageCompletionProviderCatalogSource;
	private catalog: LanguageCompletionProviderCatalog;
	private currentResolver: LanguageCompletionItemResolver | undefined;

	readonly onDidChangeProviderCatalog: Event<LanguageCompletionProviderCatalog> = this.catalogEmitter.event;

	constructor(
		private readonly model: TextModel,
		registry: LanguageCompletionProviderRegistry,
		options: LanguageCompletionServiceOptions = {},
	) {
		super();
		if (options.providers?.length) {
			registry = this._register(new LanguageCompletionProviderRegistry(registry));
			this._register(registry.registerMany(options.providers));
		}
		this.registry = registry;
		this.catalogSource = registry;
		this.catalog = registry.providerCatalog;
		if (options.onProviderError !== undefined && typeof options.onProviderError !== "function") {
			this.dispose();
			throw new TypeError("Language completion provider error handler must be a function");
		}
		if (options.workerFactory !== undefined && typeof options.workerFactory !== "function") {
			this.dispose();
			throw new TypeError("Language completion worker factory must be a function");
		}
		if (options.resource !== undefined && !(options.resource instanceof URI)) {
			this.dispose();
			throw new TypeError("Language completion resource must be a URI");
		}
		if (options.workerFactory && options.onProviderError) {
			this.dispose();
			throw new TypeError("A custom language completion worker owns its provider error policy");
		}
		this.results = this._register(createLanguageCompletionStore(model));
		this.resource = options.resource;
		const createWorker = (): LanguageCompletionWorker => {
			const worker = options.workerFactory
				? options.workerFactory()
				: new LanguageCompletionProviderWorker(this.registry, options.onProviderError);
			try {
				if (options.workerFactory) {
					if (isCatalogSource(worker)) this.bindCatalogSource(worker);
					else this.bindCatalogSource(this.registry);
				}
				this.currentResolver = isCompletionItemResolver(worker) ? worker : undefined;
				return worker;
			} catch (error) {
				worker.dispose();
				throw error;
			}
		};
		this.coordinator = this._register(new LanguageRequestCoordinator(
			model,
			createWorker,
		));
		this.bindCatalogSource(registry);
		if (options.workerFactory) {
			try {
				this.coordinator.startWorker();
			} catch (error) {
				this.dispose();
				throw error;
			}
		}
		this._register(toDisposable(() => {
			this.currentResolver = undefined;
		}));
	}

	private readonly resource: URI | undefined;

	get textModel(): TextModel {
		return this.model;
	}

	get providerCatalog(): LanguageCompletionProviderCatalog {
		return this.catalog;
	}

	supportsTriggerCharacter(languageId: string, triggerCharacter: string): boolean {
		const context = createLanguageCompletionTriggerCharacterContext(triggerCharacter);
		return this.catalog.providers.some(provider => languageCompletionProviderMatches(provider, languageId, context));
	}

	async requestTriggerCharacter(languageId: string, position: Position, triggerCharacter: string, options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome | undefined> {
		const context = createLanguageCompletionTriggerCharacterContext(triggerCharacter);
		const modelVersion = this.model.version;
		this.model.offsetAt(position);
		options.signal?.throwIfAborted();
		this.coordinator.startWorker();
		let catalog: LanguageCompletionProviderCatalog;
		try {
			catalog = await waitForCatalog(this.catalogSource, options.signal);
		} catch (error) {
			if (!options.signal?.aborted) this.restartFailedCatalogWorker(error);
			throw error;
		}
		if (this.model.version !== modelVersion) return undefined;
		if (!catalog.providers.some(provider => languageCompletionProviderMatches(provider, languageId, context))) {
			return undefined;
		}
		return this.request(languageId, position, context, options);
	}

	request(languageId: string, position: Position, context: LanguageCompletionRequest["context"], options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome> {
		const request = Object.freeze({ languageId, ...(this.resource ? { resource: this.resource } : {}), position, context });
		assertLanguageCompletionRequest(request);
		this.model.offsetAt(position);
		return this.coordinator.runLatest(
			LANGUAGE_COMPLETION_LANE,
			request,
			result => {
				const acceptance = this.results.accept(result);
				if (acceptance !== LanguageResultAcceptance.Applied) {
					throw new Error(`Completion result store rejected current result as '${acceptance}'`);
				}
			},
			options,
		);
	}

	async resolveCompletionItem(request: LanguageCompletionResolveRequest, signal: AbortSignal): Promise<LanguageCompletionItemDetails> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const normalized = normalizeLanguageCompletionResolveRequest(request);
		this.assertCurrentResolveRequest(normalized);
		this.coordinator.startWorker();
		const resolver = this.currentResolver;
		if (!resolver) {
			throw new ReferenceError("The current language completion Worker does not support item resolution");
		}
		const details = await resolver.resolveCompletionItem(normalized, signal);
		signal.throwIfAborted();
		this.assertNotDisposed();
		this.assertCurrentResolveRequest(normalized);
		return normalizeLanguageCompletionItemDetails(details);
	}

	async executeCompletionCommand(languageId: string, item: LanguageCompletionItem, signal: AbortSignal): Promise<void> {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		signal.throwIfAborted();
		if (!item.command) return;
		const provider = this.registry.getProvider(item.providerId);
		if (!provider?.executeCompletionCommand) throw new ReferenceError(`Language completion provider '${item.providerId}' cannot execute completion commands`);
		await provider.executeCompletionCommand(Object.freeze({ languageId, ...(this.resource ? { resource: this.resource } : {}), snapshot: this.model.createVersionedSnapshot(), command: item.command }), signal);
		signal.throwIfAborted();
		this.assertNotDisposed();
	}

	private bindCatalogSource(source: LanguageCompletionProviderCatalogSource): void {
		this.catalogSource = source;
		this.catalog = source.providerCatalog;
		this.catalogSubscription.value = source.onDidChangeProviderCatalog(catalog => {
			this.catalog = catalog;
			this.catalogEmitter.fire(catalog);
		});
		this.catalogEmitter.fire(this.catalog);
	}

	private restartFailedCatalogWorker(catalogError: unknown): void {
		try {
			this.coordinator.restartWorker();
		} catch (disposalError) {
			throw new AggregateError(
				[catalogError, disposalError],
				"Completion provider catalog and Worker disposal both failed",
			);
		}
	}

	private assertCurrentResolveRequest(request: LanguageCompletionResolveRequest): void {
		const result = this.results.result;
		const item = result?.value.items.find(candidate => candidate.providerId === request.providerId && candidate.id === request.itemId);
		if (!result || result.requestId !== request.completionRequestId || result.modelVersion !== request.modelVersion || !item?.hasDeferredDetails) {
			throw new ReferenceError("Language completion resolve request is not the current deferred item");
		}
	}

}

/** Coordinator-compatible host that runs matching providers concurrently. */
export class LanguageCompletionProviderWorker implements LanguageCompletionWorker, LanguageCompletionItemResolver {
	private resolutionCache: CompletionResolutionCache | undefined;
	private disposed = false;

	constructor(
		private readonly registry: LanguageCompletionProviderRegistry,
		private readonly onProviderError: LanguageCompletionProviderErrorHandler = reportProviderError,
	) {
		if (typeof onProviderError !== "function") {
			throw new TypeError("Language completion provider error handler must be a function");
		}
	}

	async run(request: LanguageWorkerRequest<LanguageCompletionLane, LanguageCompletionRequest>, signal: AbortSignal): Promise<LanguageCompletionResult> {
		this.ensureAlive();
		signal.throwIfAborted();
		assertLanguageCompletionRequest(request.payload);
		const providers = this.registry.getProviders(
			request.payload.languageId,
			request.payload.context,
		);
		if (providers.length === 0) {
			this.resolutionCache = createResolutionCache(request, []);
			return mergeProviderResults(request.payload.position, []);
		}
		const normalizeResult = createLanguageCompletionSnapshotNormalizer(request.snapshot);
		const batches = await Promise.all(providers.map(provider => (
			this.runProvider(provider, request, signal, normalizeResult)
		)));
		signal.throwIfAborted();
		const result = mergeProviderResults(request.payload.position, batches.map(batch => batch?.result));
		this.resolutionCache = createResolutionCache(request, batches);
		return result;
	}

	dispose(): void {
		this.disposed = true;
		this.resolutionCache = undefined;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	async resolveCompletionItem(request: LanguageCompletionResolveRequest, signal: AbortSignal): Promise<LanguageCompletionItemDetails> {
		this.ensureAlive();
		signal.throwIfAborted();
		const normalized = normalizeLanguageCompletionResolveRequest(request);
		const cache = this.resolutionCache;
		if (!cache || cache.completionRequestId !== normalized.completionRequestId || cache.modelVersion !== normalized.modelVersion) {
			throw new ReferenceError("Language completion resolve request no longer has a provider result");
		}
		const entry = cache.items.get(completionIdentity(normalized.providerId, normalized.itemId));
		if (!entry || this.registry.getProvider(normalized.providerId) !== entry.provider || !entry.provider.resolveCompletionItem) {
			throw new ReferenceError(`Language completion item '${normalized.providerId}/${normalized.itemId}' cannot be resolved`);
		}
		let details: LanguageCompletionItemDetails;
		try {
			const value = await entry.provider.resolveCompletionItem(Object.freeze({
				completionRequestId: normalized.completionRequestId,
				modelVersion: normalized.modelVersion,
				item: entry.item,
			}), signal);
			signal.throwIfAborted();
			details = normalizeLanguageCompletionItemDetails(value);
		} catch (error) {
			if (!signal.aborted) this.reportProviderError(entry.provider.id, error);
			throw error;
		}
		if (this.resolutionCache !== cache || this.registry.getProvider(normalized.providerId) !== entry.provider) {
			throw new ReferenceError("Language completion resolve result became stale");
		}
		return details;
	}

	private async runProvider(
		provider: RegisteredLanguageCompletionProvider,
		request: LanguageWorkerRequest<LanguageCompletionLane, LanguageCompletionRequest>,
		signal: AbortSignal,
		normalizeResult: LanguageCompletionResultNormalizer,
	): Promise<ResolvedProviderBatch | undefined> {
		const providerRequest = Object.freeze<LanguageCompletionProviderRequest>({
			requestId: request.requestId,
			snapshot: request.snapshot,
			...request.payload,
		});
		try {
			const value = await provider.provideCompletions(providerRequest, signal);
			signal.throwIfAborted();
			if (value === undefined) return undefined;
			assertProviderResult(value);
			const result = normalizeResult({
				position: request.payload.position,
				items: value.items.map(item => createCompletionResultItem(provider, item)),
				isIncomplete: value.isIncomplete,
			});
			const resolutions = provider.resolveCompletionItem === undefined
				? Object.freeze([])
				: Object.freeze(result.items.flatMap((item, index) => value.items[index]!.resolveData === undefined ? [] : [Object.freeze({
					provider,
					item: createProviderResolveItem(item, value.items[index]!.resolveData),
				})]));
			return Object.freeze({ result, resolutions });
		} catch (error) {
			if (signal.aborted) throw error;
			this.reportProviderError(provider.id, error);
			return undefined;
		}
	}

	private reportProviderError(providerId: string, error: unknown): void {
		try {
			this.onProviderError(providerId, error);
		} catch (reportingError) {
			reportProviderError(providerId, new AggregateError(
				[error, reportingError],
				"Completion provider and error reporter both failed",
			));
		}
	}

	private ensureAlive(): void {
		if (this.disposed) {
			throw new ReferenceError("LanguageCompletionProviderWorker is already disposed");
		}
	}
}

interface ProviderBatch {
	readonly items: readonly LanguageCompletionItem[];
	readonly isIncomplete: boolean;
}

interface ResolvedProviderBatch {
	readonly result: LanguageCompletionResult;
	readonly resolutions: readonly CompletionResolutionEntry[];
}

interface CompletionResolutionEntry {
	readonly provider: RegisteredLanguageCompletionProvider;
	readonly item: LanguageCompletionProviderItem;
}

interface CompletionResolutionCache {
	readonly completionRequestId: number;
	readonly modelVersion: number;
	readonly items: ReadonlyMap<string, CompletionResolutionEntry>;
}

function mergeProviderResults(position: Position, batches: readonly (ProviderBatch | undefined)[]): LanguageCompletionResult {
	const items: LanguageCompletionItem[] = [];
	let hasPreselection = false;
	let isIncomplete = false;
	for (const batch of batches) {
		if (!batch) continue;
		isIncomplete ||= batch.isIncomplete;
		for (const item of batch.items) {
			const { preselect, ...rest } = item;
			const keepPreselection: boolean = preselect === true && !hasPreselection;
			if (keepPreselection) hasPreselection = true;
			items.push(Object.freeze({
				...rest,
				...(keepPreselection ? { preselect: true } : preselect === false ? { preselect: false } : {}),
			}));
		}
	}
	return Object.freeze({
		position,
		items: Object.freeze(items),
		isIncomplete,
	});
}

function createResolutionCache(request: LanguageWorkerRequest<LanguageCompletionLane, LanguageCompletionRequest>, batches: readonly (ResolvedProviderBatch | undefined)[]): CompletionResolutionCache {
	const items = new Map<string, CompletionResolutionEntry>();
	for (const batch of batches) {
		for (const entry of batch?.resolutions ?? []) {
			items.set(completionIdentity(entry.provider.id, entry.item.id), entry);
		}
	}
	return Object.freeze({
		completionRequestId: request.requestId,
		modelVersion: request.snapshot.version,
		items,
	});
}

function createProviderResolveItem(item: LanguageCompletionItem, resolveData: unknown): LanguageCompletionProviderItem {
	return Object.freeze({
		id: item.id,
		label: item.label,
		kind: item.kind,
		range: item.range,
		insertText: item.insertText,
		...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
		...(item.detail === undefined ? {} : { detail: item.detail }),
		...(item.documentation === undefined ? {} : { documentation: item.documentation }),
		...(item.filterText === undefined ? {} : { filterText: item.filterText }),
		...(item.sortText === undefined ? {} : { sortText: item.sortText }),
		...(item.preselect === undefined ? {} : { preselect: item.preselect }),
		...(item.commitCharacters === undefined ? {} : { commitCharacters: item.commitCharacters }),
		...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: item.additionalTextEdits }),
		...(item.command === undefined ? {} : { command: item.command }),
		...(resolveData === undefined ? {} : { resolveData: structuredClone(resolveData) }),
	});
}

function createCompletionResultItem(provider: RegisteredLanguageCompletionProvider, item: LanguageCompletionProviderItem): LanguageCompletionItem {
	return {
		providerId: provider.id,
		id: item.id,
		label: item.label,
		kind: item.kind,
		range: item.range,
		insertText: item.insertText,
		...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
		...(item.detail === undefined ? {} : { detail: item.detail }),
		...(item.documentation === undefined ? {} : { documentation: item.documentation }),
		...(item.filterText === undefined ? {} : { filterText: item.filterText }),
		...(item.sortText === undefined ? {} : { sortText: item.sortText }),
		...(item.preselect === undefined ? {} : { preselect: item.preselect }),
		...(item.commitCharacters === undefined ? {} : { commitCharacters: item.commitCharacters }),
		...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: item.additionalTextEdits }),
		...(item.command === undefined ? {} : { command: item.command }),
		...(provider.resolveCompletionItem === undefined || item.resolveData === undefined ? {} : { hasDeferredDetails: true }),
	};
}

function completionIdentity(providerId: string, itemId: string): string {
	return `${providerId}\0${itemId}`;
}

function assertProviderResult(result: LanguageCompletionProviderResult): void {
	if (
		typeof result !== "object" ||
		result === null ||
		!Array.isArray(result.items) ||
		typeof result.isIncomplete !== "boolean"
	) {
		throw new TypeError("Language completion provider result must contain items and isIncomplete");
	}
}

function reportProviderError(providerId: string, error: unknown): void {
	console.error(`Language completion provider '${providerId}' failed`, error);
}

function isCatalogSource(value: LanguageCompletionWorker): value is LanguageCompletionWorker & LanguageCompletionProviderCatalogSource {
	const candidate = value as Partial<LanguageCompletionProviderCatalogSource>;
	return typeof candidate.onDidChangeProviderCatalog === "function" &&
		typeof candidate.waitForProviderCatalog === "function" &&
		typeof candidate.providerCatalogReady === "boolean" &&
		typeof candidate.providerCatalog === "object";
}

function isCompletionItemResolver(value: LanguageCompletionWorker): value is LanguageCompletionWorker & LanguageCompletionItemResolver {
	return typeof (value as Partial<LanguageCompletionItemResolver>).resolveCompletionItem === "function";
}

function waitForCatalog(source: LanguageCompletionProviderCatalogSource, signal: AbortSignal | undefined): Promise<LanguageCompletionProviderCatalog> {
	if (!signal) return source.waitForProviderCatalog();
	return raceCancellationError(source.waitForProviderCatalog(), signal, "Completion provider catalog wait was cancelled");
}

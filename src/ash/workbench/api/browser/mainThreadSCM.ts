import { raceCancellationError, TaskQueue, timeout } from '../../../base/common/async.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { CommandRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IMultiDiffSourceResolverService } from '../../contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { isMultiDiffEditorInput, requireActions } from '../../contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { parseExtensionEditorInput } from './mainThreadEditorInput.js';
import { Disposable, DisposableMap, DisposableStore, noneDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { structuralEquals } from '../../../base/common/equals.js';
import { observableValue } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { Icon } from '../../../base/common/icon.js';
import { LRUCache } from '../../../base/common/map.js';
import type { IAction } from '../../../base/common/actions.js';
import { IExtensionHostApi, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { ISCMService, ISCMViewService, type ISCMProvider, type ISCMResourceGroup, type ISCMConflictFile, type ISCMConflictResolution, type ISCMActionButtonDescriptor } from '../../contrib/scm/common/scm.js';
import type { ISCMHistoryProvider, ISCMHistoryItem, ISCMHistoryOptions, ISCMHistoryItemRef, ISCMHistoryItemChange, ISCMHistoryItemDetails, ISCMHistoryItemChangeContents } from '../../contrib/scm/common/history.js';
import { IQuickDiffService } from '../../contrib/scm/common/quickDiff.js';
import { IDecorationsService } from '../../services/decorations/common/decorations.js';
import { ITimelineService } from '../../contrib/timeline/common/timeline.js';
import { IEditorPart } from '../../browser/parts/editor/editorPart.js';
import { isResourceDiffEditorInput } from '../../common/editor.js';
class SCMRegistration extends Disposable {
	public revision = 0;
	public initialization: 'initializing' | 'ready' | 'failed' = 'initializing';
	public initializing: Promise<void> | undefined;
	public readonly providers = this._register(new DisposableMap<string, ExtensionSCMProvider>());
	public readonly controller = new AbortController();
	constructor(public readonly source: ExtensionClientSource, public readonly registrationId: string) {
		super();
		this._register(toDisposable(() => this.controller.abort('SCM extension was retired')));
	}
}
/** SCM owns view state; all repository policy and commands remain in the extension. */
export class MainThreadSCM extends Disposable {
	// Decorations share the window's 32 invocation slots with initialization and commands.
	// Bound only this high-volume read path; a command must not wait behind file labels.
	private readonly decorationQueues = Array.from({ length: 4 }, () => new TaskQueue());
	private nextDecorationQueue = 0;
	private timelineSequence = 0;
	private readonly initializationContexts = new Map<string, IContextKey<string>>();
	private readonly registrations = this._register(new DisposableMap<string, SCMRegistration>());
	constructor(private readonly timeout: number, private readonly reportError: (error: unknown) => void, private readonly commandRegistry: CommandRegistry,
		@IExtensionHostApi
		private readonly api: IExtensionHostApi,
		@ISCMService
		private readonly scm: ISCMService,
		@ISCMViewService
		private readonly view: ISCMViewService,
		@ICommandService
		private readonly commands: ICommandService,
		@IMultiDiffSourceResolverService
		private readonly multiDiff: IMultiDiffSourceResolverService,
		@IQuickDiffService
		private readonly quickDiff: IQuickDiffService,
		@IDecorationsService
		private readonly decorations: IDecorationsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ITimelineService private readonly timeline: ITimelineService,
		@IEditorPart private readonly editorPart: IEditorPart) {
		super();
		this._register(commandRegistry.register('workbench.scm.action.retryInitialization', async () => {
			const registered = new Set([...this.registrations].map(([, owner]) => owner.source.extensionId));
			if ([...this.initializationContexts].some(([id, context]) => context.get() === 'failed' && !registered.has(id))) {
				// A process can fail before registering SCM. The fleet owner publishes its
				// replacement and activates it through the usual startup path.
				await this.api.reconcile('restartFailed');
			}
			await Promise.all([...this.registrations].map(([, owner]) => owner)
				.filter(owner => owner.initialization === 'failed').map(owner => this.initialize(owner)));
		}));
		this._register(toDisposable(() => {
			for (const queue of this.decorationQueues) queue.clearPending();
			for (const context of this.initializationContexts.values()) context.reset();
		}));
	}
	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const current = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) {
				continue;
			}
			for (const registration of runtime.registrations) {
				if (registration.kind === 'sourceControl') {
					current.add(registrationKey({ extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation }, registration.registrationId));
				}
			}
		}
		// Retire the old process before its replacement reuses repository identities.
		for (const key of this.registrations.keys()) {
			if (!current.has(key)) {
				this.registrations.deleteAndDispose(key);
			}
		}
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) {
				continue;
			}
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'sourceControl') {
					continue;
				}
				const source = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation };
				const key = registrationKey(source, registration.registrationId);
				if (!this.registrations.has(key)) {
					const owner = this.registrations.set(key, new SCMRegistration(source, registration.registrationId));
					this.set(source, registration.registrationId, registration.revision, registration.providers);
					void this.initialize(owner);
				} else {
					this.set(source, registration.registrationId, registration.revision, registration.providers);
				}
			}
		}
		this.updateInitializationContexts(snapshot);
	}
	private initialize(owner: SCMRegistration): Promise<void> {
		if (owner.initializing) return owner.initializing;
		owner.initialization = 'initializing';
		this.updateInitializationContexts();
		// Initialization discovers repositories and starts the provider's subscriptions.
		// It is idempotent, so transient admission/startup failures can be retried safely.
		owner.initializing = this.initializeWithRetry(owner).finally(() => { owner.initializing = undefined; });
		return owner.initializing;
	}
	private async initializeWithRetry(owner: SCMRegistration): Promise<void> {
		const signal = owner.controller.signal;
		for (const delay of [0, 250, 1000]) {
			try {
				if (delay) {
					const waiting = timeout(delay);
					try { await raceCancellationError(waiting, signal); }
					finally { waiting.cancel(); }
				}
				await this.invoke(owner, 'initialize', {});
				owner.initialization = 'ready';
				this.updateInitializationContexts();
				return;
			} catch (error) {
				if (signal.aborted) return;
				this.reportError(error);
			}
		}
		owner.initialization = 'failed';
		this.updateInitializationContexts();
	}
	private updateInitializationContexts(snapshot?: ExtensionHostFleetSnapshot): void {
		if (this.isDisposed) return;
		const states = new Map<string, SCMRegistration['initialization'][]>();
		for (const [, owner] of this.registrations) {
			const values = states.get(owner.source.extensionId) ?? [];
			values.push(owner.initialization);
			states.set(owner.source.extensionId, values);
		}
		// Failed activation has no SCM registration to initialize or retry. Include
		// the runtime lifecycle so the welcome view cannot remain "scanning" forever.
		if (snapshot) {
			for (const runtime of snapshot.extensions) {
				if (states.has(runtime.id) || runtime.lifecycle === 'ready') continue;
				const failed = runtime.lifecycle === 'failed' || runtime.lifecycle === 'crashLoop' || runtime.lifecycle === 'stopped';
				states.set(runtime.id, [failed ? 'failed' : 'initializing']);
			}
		}
		this.contextKeys.bufferChangeEvents(() => {
			if (snapshot) {
				for (const [id, context] of this.initializationContexts) {
					if (!states.has(id)) { context.reset(); this.initializationContexts.delete(id); }
				}
			}
			for (const [id, values] of states) {
				let context = this.initializationContexts.get(id);
				if (!context) {
					context = this.contextKeys.createKey<string>(`scm.providerState.${id}`, 'initializing');
					this.initializationContexts.set(id, context);
				}
				context.set(values.includes('failed') ? 'failed' : values.includes('initializing') ? 'initializing' : 'ready');
			}
		});
	}
	public set(source: ExtensionClientSource, registrationId: string, revision: number, values: readonly JsonValue[]): void {
		this.assertNotDisposed();
		const owner = this.registrations.get(registrationKey(source, registrationId));
		if (!owner) {
			throw new Error('SCM update belongs to a retired registration');
		}
		if (revision <= owner.revision) {
			return;
		}
		// Normalize the whole replacement before changing the existing view.
		const snapshots = values.map(parseProvider);
		if (new Set(snapshots.map(value => value.id)).size !== snapshots.length) {
			throw new TypeError('Duplicate SCM provider');
		}
		for (const value of snapshots) {
			const existing = owner.providers.get(value.id);
			if (!existing && this.scm.getRepository(value.id)) {
				throw new TypeError('SCM repository identity is already registered');
			}
			if (existing && (existing.providerId !== value.providerId || existing.rootUri?.toString() !== value.rootUri || Boolean(existing.historyProvider) !== value.hasHistory || Boolean(existing.mergeProvider) !== value.hasMerge || existing.hasTimeline !== Boolean(value.timeline) || Boolean(existing.historyProvider?.provideHistoryItemRefs) !== value.hasHistoryItemRefs || Boolean(existing.historyProvider?.resolveHistoryItemRefsCommonAncestor) !== value.hasHistoryMergeBase)) {
				throw new TypeError('SCM provider identity cannot change within a registration');
			}
			if (value.multiDiff) {
				const prefix = URI.parse(string(value.multiDiff.resourcePrefix));
				if (prefix.scheme !== 'ash-scm' || prefix.authority !== source.extensionId || prefix.query || prefix.fragment) {
					throw new TypeError('Multi-diff source must belong to its extension');
				}
				requireActions(value.multiDiff.sourceActions);
				requireActions(value.multiDiff.repositoryActions);
			}
		}
		const current = new Set(snapshots.map(value => value.id));
		for (const id of owner.providers.keys()) {
			if (!current.has(id)) {
				owner.providers.deleteAndDispose(id);
			}
		}
		for (const value of snapshots) {
			let provider = owner.providers.get(value.id);
			// Resource updates must not replay a previously consumed selection request.
			const select = value.selected && (!provider || value.selectionRevision > provider.selectionRevision);
			if (!provider) {
				if (this.scm.getRepository(value.id)) {
					throw new Error('SCM repository identity is already registered');
				}
				provider = owner.providers.set(value.id, new ExtensionSCMProvider(value, (method, payload, signal) => this.invoke(owner, method, { providerId: value.id, ...payload }, signal), this.reportError));
				provider.add(this.scm.registerSCMProvider(provider));
				if (value.timeline) {
					const id = `scm:${source.extensionId}:${value.id}`;
					const currentProvider = provider;
					const openCommand = `workbench.scm.timeline.open.${++this.timelineSequence}`;
					provider.add(this.commandRegistry.register(openCommand, async (_accessor, resource, handle) => {
						if (typeof resource !== 'string' || typeof handle !== 'string') throw new TypeError('Invalid SCM timeline entry');
						await currentProvider.call('timeline', { methodName: 'open', resource: string(resource), handle: string(handle) });
					}));
					provider.add(this.timeline.registerTimelineProvider({
						id, label: value.timeline.label, scheme: provider.rootUri?.scheme ?? '*',
						onDidChange: listener => currentProvider.onDidChangeTimeline(() => listener({ id, uri: undefined, reset: true })),
						provideTimeline: async (resource, options, token) => {
							if (currentProvider.rootUri && !extUriBiasedIgnorePathCase.isEqualOrParent(resource, currentProvider.rootUri)) return undefined;
							const controller = new AbortController();
							using cancellation = token.onCancellationRequested(() => controller.abort());
							if (token.isCancellationRequested) controller.abort();
							const response = await currentProvider.call('timeline', { methodName: 'provide', resource: resource.toString(), options }, controller.signal);
							if (response === null) return undefined;
							const result = object(response);
							return {
								source: id,
								items: await Promise.all(array(result.items).map(async value => {
									const item = object(value);
									const handle = string(item.handle);
									const historyItemId = optionalString(item.id);
									const historyItem = item.historyItem == null || !currentProvider.historyProvider
										? undefined : await currentProvider.prepareHistoryItem(parseHistoryItem(item.historyItem));
									controller.signal.throwIfAborted();
									return {
										source: id, handle, id: historyItemId, label: string(item.label), timestamp: number(item.timestamp),
										description: optionalString(item.description), tooltip: optionalString(item.tooltip),
										sourceControl: historyItem ? { repositoryId: currentProvider.id, historyItem } : undefined,
										icon: item.icon == null ? undefined : Icon.fromId(string(item.icon)),
										command: { id: openCommand, title: string(item.label), arguments: [resource.toString(), handle] },
									};
								})),
								paging: { cursor: optionalString(result.cursor) },
							};
						},
						...noneDisposable,
					}));
				}
				if (value.multiDiff) {
					const metadata = value.multiDiff;
					const prefix = string(metadata.resourcePrefix);
					const uri = URI.parse(prefix);
					if (uri.scheme !== 'ash-scm' || uri.authority !== source.extensionId) {
						throw new TypeError('Multi-diff source must belong to its extension');
					}
					const actions = (values: JsonValue) => requireActions(values).map(action => ({ ...action, icon: action.icon ? Icon.fromId(action.icon) : undefined, enabled: !provider!.isBusy && action.enabled !== false, run: () => this.commands.executeCommand(action.command, ...action.arguments) }));
					provider.add(this.multiDiff.registerResolver({
						canHandleUri: resource => resource.with({ query: '', fragment: '' }).toString() === prefix,
						resolveDiffSource: async (resource) => {
							const input = parseExtensionEditorInput(await provider!.call('multiDiff', { resource: resource.toString() })); if (!isMultiDiffEditorInput(input)) {
								throw new TypeError('Source resolver must return a multi-diff input');
							} return { resource: input.resource, resources: input.items, label: input.label, source: input.source };
						},
						sourceActions: () => actions(metadata.sourceActions),
						primaryRepositoryAction: input => input.source?.kind === 'external' && input.source.providerId === source.extensionId && input.source.repositoryId === value.id ? actions(metadata.repositoryActions)[0] : undefined,
						repositoryActions: input => input.source?.kind === 'external' && input.source.providerId === source.extensionId && input.source.repositoryId === value.id ? actions(metadata.repositoryActions) : [],
					}));
					provider.add(provider.onDidChangeResources(() => this.multiDiff.notifyChanged()));
				}
				provider.add(this.quickDiff.addProvider({
					id: `${source.extensionId}:${value.id}`, label: value.label, rootUri: provider.rootUri, onDidChange: listener => provider!.onDidChangeResources(() => listener(undefined)), provideOriginalResource: async (resource, signal) => {
						const result = await provider!.call('quickDiff', { resource: resource.toString() }, signal);
						if (result === null) {
							return undefined;
						}
						const original = object(result);
						return { providerId: `${source.extensionId}:${value.id}`, providerLabel: provider!.label, label: original.label == null ? provider!.label : string(original.label), originalResource: URI.parse(string(original.originalResource ?? original.resource)), revision: original.revision == null ? owner.revision : typeof original.revision === 'number' ? original.revision : string(original.revision), text: string(original.text, 16 * 1024 * 1024) };
					}
				}));
				provider.add(this.decorations.registerDecorationsProvider({
					label: value.label, onDidChange: provider.onDidChangeDecorations, provideDecorations: async (resource, token) => {
						const controller = new AbortController();
						using listener = token.onCancellationRequested(() => controller.abort());
						if (token.isCancellationRequested) {
							controller.abort();
						}
						let result = await provider!.call('decoration', { resource: resource.toString() }, controller.signal);
						let inherited = false;
						if (result === null) {
							// Collapsed folders have no rendered children to populate the decoration cache.
							// Ask the owner about a current changed descendant; it still controls whether
							// decorations are enabled and may bubble, while direct folder data wins.
							const descendant = provider!.groups.flatMap(group => group.resources).find(change =>
								!extUriBiasedIgnorePathCase.isEqual(change.sourceUri, resource) && extUriBiasedIgnorePathCase.isEqualOrParent(change.sourceUri, resource));
							if (descendant) {
								result = await provider!.call('decoration', { resource: descendant.sourceUri.toString() }, controller.signal);
								inherited = true;
							}
						}
						if (result === null) {
							return undefined;
						}
						const data = object(result);
						if (inherited && data.bubble !== true) {
							return undefined;
						}
						return { tooltip: optionalString(data.tooltip), color: optionalString(data.color), letter: inherited ? '●' : optionalString(data.letter), weight: typeof data.weight === 'number' ? data.weight : undefined, bubble: data.bubble === true, strikethrough: !inherited && data.strikethrough === true };
					}
				}));
			} else {
				provider.accept(value);
			}
			if (select) {
				this.view.selectRepository(value.id);
			}
		}
		owner.revision = revision;
	}
	private async invoke(owner: SCMRegistration, method: string, payload: Record<string, unknown>, requestSignal?: AbortSignal): Promise<JsonValue> {
		owner.controller.signal.throwIfAborted();
		const signal = requestSignal ? AbortSignal.any([owner.controller.signal, requestSignal]) : owner.controller.signal;
		const run = async (): Promise<JsonValue> => {
			signal.throwIfAborted();
			// A published repository may start a graph or decoration read while discovery is still in flight.
			// Keep consumers behind the registration's initializer and retain caller/retirement cancellation.
			if (method !== 'initialize' && owner.initialization === 'initializing') {
				await raceCancellationError(this.initialize(owner), signal);
				signal.throwIfAborted();
			}
			// Queueing does not consume the invocation's backend deadline or an admission slot.
			const openComparisons = method === 'open' && !payload.sideBySide
				? this.editorPart.activeGroup.inputs.slice(0, 256).flatMap(input => isResourceDiffEditorInput(input) ? [{ original: input.original.resource.toString(), modified: input.modified.resource.toString() }] : [])
				: undefined;
			return this.api.invoke({ ...owner.source, registrationId: owner.registrationId, operation: 'scm', payload: normalizeExtensionHostPayload(JSON.parse(JSON.stringify({ method, ...payload, ...(openComparisons ? { openComparisons } : {}) }))), deadlineUnixMillis: Date.now() + this.timeout }, signal);
		};
		const result = method === 'decoration'
			? await this.decorationQueues[this.nextDecorationQueue++ % this.decorationQueues.length]!.schedule(run)
			: await run();
		signal.throwIfAborted();
		return result;
	}
	public reviveCommandArguments(source: ExtensionClientSource, args: readonly JsonValue[]): unknown[] {
		return args.map(value => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
			const entry = object(value);
			if (entry.type !== 'historyItemViewModel') return value;
			const descriptor = object(entry.repository);
			const providerId = string(object(descriptor.provider).id);
			const repository = this.scm.getRepository(providerId);
			const owned = [...this.registrations].some(([, owner]) => owner.source.extensionId === source.extensionId && owner.source.activationGeneration === source.activationGeneration && owner.source.incarnation === source.incarnation && owner.providers.get(providerId) === repository?.provider);
			if (!repository || !owned) throw new TypeError('SCM history command belongs to a retired or foreign repository');
			return {
				type: entry.type, repository,
				historyItemViewModel: { historyItem: parseHistoryItem(object(entry.historyItemViewModel).historyItem) },
				references: entry.references == null ? undefined : array(entry.references).map(parseRef),
			};
		});
	}
	public async prepareCommandArguments(extensionId: string, args: readonly unknown[]): Promise<JsonValue[]> {
		for (const [, owner] of this.registrations) {
			if (owner.source.extensionId !== extensionId) {
				continue;
			}
			for (const [, provider] of owner.providers) {
				await provider.syncInput();
			}
		}
		const encode = (value: unknown): unknown => {
			if (value instanceof URI) {
				return value.toString();
			}
			if (value && typeof value === 'object' && 'repositoryId' in value && typeof value.repositoryId === 'string' && 'runTitleOperation' in value) {
				return { repositoryId: value.repositoryId };
			}
			if (value && typeof value === 'object' && 'repository' in value) {
				const context = value as {
					repository: unknown;
					type?: string;
					historyItemViewModel?: unknown;
					references?: unknown;
				};
				return { type: context.type, repository: encode(context.repository), historyItemViewModel: encode(context.historyItemViewModel), references: encode(context.references) };
			}
			if (value && typeof value === 'object' && 'provider' in value) {
				const provider = (value as {
					provider?: ISCMProvider;
				}).provider;
				if (provider && this.scm.getRepository(provider.id)?.provider === provider) {
					const context = value as {
						type?: string;
						historyItemViewModel?: {
							historyItem: unknown;
						};
						references?: unknown;
					};
					return { repositoryId: provider.id, provider: { id: provider.id, providerId: provider.providerId }, ...(context.type === 'historyItemViewModel' ? { type: context.type, repository: { provider: { id: provider.id, providerId: provider.providerId } }, historyItemViewModel: encode(context.historyItemViewModel), references: encode(context.references) } : {}) };
				}
			}
			if (Array.isArray(value)) {
				return value.map(encode);
			}
			if (value && typeof value === 'object') {
				return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).map(([key, value]) => [key, encode(value)]));
			}
			return value ?? null;
		};
		return args.map(value => normalizeExtensionHostPayload(encode(value)));
	}
	public clear(): void {
		this.registrations.clearAndDisposeAll();
		for (const queue of this.decorationQueues) queue.clearPending();
		this.contextKeys.bufferChangeEvents(() => {
			for (const context of this.initializationContexts.values()) context.reset();
			this.initializationContexts.clear();
		});
	}
}
interface ProviderSnapshot {
	readonly id: string;
	readonly providerId: string;
	readonly label: string;
	readonly rootUri: string | undefined;
	readonly selected: boolean;
	readonly selectionRevision: number;
	readonly groups: readonly Record<string, JsonValue>[];
	readonly input: Record<string, JsonValue>;
	readonly actionButton: ISCMActionButtonDescriptor | undefined;
	readonly activeRepositoryName: string | undefined;
	readonly count: number | undefined;
	readonly statusMessage: string;
	readonly isBusy: boolean;
	readonly statusBarCommands: readonly Record<string, JsonValue>[];
	readonly historyRef: ISCMHistoryItemRef | undefined;
	readonly historyRemoteRef: ISCMHistoryItemRef | undefined;
	readonly historyBaseRef: ISCMHistoryItemRef | undefined;
	readonly hasHistoryItemRefs: boolean;
	readonly hasHistoryMergeBase: boolean;
	readonly historyRevision: number;
	readonly historyRefsRevision: number;
	readonly historyRefsItems: readonly ISCMHistoryItem[];
	readonly hasHistory: boolean;
	readonly hasMerge: boolean;
	readonly inputRevision: number;
	readonly multiDiff: Record<string, JsonValue> | undefined;
	readonly timeline: { readonly label: string; readonly resetKey: string | undefined; } | undefined;
}
class ExtensionSCMProvider extends Disposable implements ISCMProvider {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeResources = this.changed.event;
	private readonly decorationChanged = this._register(new Emitter<readonly URI[]>());
	public readonly onDidChangeDecorations = this.decorationChanged.event;
	private readonly historyChanged = this._register(new Emitter<void>());
	private readonly timelineChanged = this._register(new Emitter<void>());
	public readonly onDidChangeTimeline = this.timelineChanged.event;
	private readonly historyRefsChanged = this._register(new Emitter<readonly ISCMHistoryItem[]>());
	private readonly historyRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	private readonly historyRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	private readonly historyBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	private draft: string;
	private draftRevision = 0;
	private syncedDraftRevision = 0;
	private resourceGroups: readonly ISCMResourceGroup[] | undefined;
	private openController: AbortController | undefined;
	// Both presentations read the same repository owner. Bound retained commit messages and requests.
	private readonly historyDetails = new LRUCache<string, ISCMHistoryItemDetails | Promise<ISCMHistoryItemDetails>>(128);
	private readonly detailQueues = Array.from({ length: 4 }, () => new TaskQueue());
	private nextDetailQueue = 0;
	public readonly historyProvider: ISCMHistoryProvider | undefined;
	public readonly mergeProvider;
	constructor(private snapshot: ProviderSnapshot, public readonly call: (method: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<JsonValue>, private readonly reportError: (error: unknown) => void) {
		super();
		this._register(toDisposable(() => {
			this.openController?.abort();
			this.historyDetails.clear();
			for (const queue of this.detailQueues) queue.clearPending();
		}));
		this.draft = string(snapshot.input.value);
		this.historyRef.set(snapshot.historyRef);
		this.historyRemoteRef.set(snapshot.historyRemoteRef);
		this.historyBaseRef.set(snapshot.historyBaseRef);
		if (snapshot.hasHistory) {
			this.historyProvider = {
				onDidChange: this.historyChanged.event, historyItemRef: this.historyRef, historyItemRemoteRef: this.historyRemoteRef, historyItemBaseRef: this.historyBaseRef,
				...(snapshot.hasHistoryItemRefs ? { provideHistoryItemRefs: async (refs?: readonly string[]) => array(await this.call('history', { methodName: 'provideHistoryItemRefs', arguments: [refs ?? null] })).map(parseRef) } : {}),
				...(snapshot.hasHistoryMergeBase ? { resolveHistoryItemRefsCommonAncestor: async (refs: readonly string[]) => optionalString(await this.call('history', { methodName: 'resolveHistoryItemRefsCommonAncestor', arguments: [refs] })) } : {}),
				onDidChangeHistoryItemRefs: this.historyRefsChanged.event,
				refresh: () => { void this.call('history', { methodName: 'refresh', arguments: [] }).catch(this.reportError); },
				provideHistoryItems: options => this.provideHistoryItems(options),
				provideHistoryItemChanges: async (id, parent) => array(await this.call('history', { methodName: 'provideHistoryItemChanges', arguments: [id, parent ?? null] })).map(parseHistoryChange),
				resolveHistoryItemChangeContents: async (id, change) => parseContents(await this.call('history', { methodName: 'resolveHistoryItemChangeContents', arguments: [id, encodeChange(change)] })),
				resolveHistoryItemChatContext: async (id) => optionalString(await this.call('history', { methodName: 'resolveHistoryItemChatContext', arguments: [id] }), 512 * 1024),
				resolveHistoryItemChangeRangeChatContext: async (id, parent, path) => optionalString(await this.call('history', { methodName: 'resolveHistoryItemChangeRangeChatContext', arguments: [id, parent, path] }), 512 * 1024),
			};
		}
		this.mergeProvider = snapshot.hasMerge ? {
			resolve: async (path: string): Promise<ISCMConflictFile> => parseConflict(await this.call('merge', { methodName: 'resolve', arguments: [path] })),
			complete: async (path: string, stageIds: readonly (string | null)[], objectId: string | null, resolution: ISCMConflictResolution): Promise<void> => { await this.call('merge', { methodName: 'complete', arguments: [path, stageIds, objectId, resolution] }); },
			errorMessage: (error: unknown): string => String(error),
		} : undefined;
	}

	private async provideHistoryItems(options: ISCMHistoryOptions): Promise<readonly ISCMHistoryItem[]> {
		const items = array(await this.call('history', { methodName: 'provideHistoryItems', arguments: [options] })).map(parseHistoryItem);
		return Promise.all(items.map(item => this.prepareHistoryItem(item)));
	}

	/** Both list providers publish an item only after its complete tooltip is available. */
	public async prepareHistoryItem(item: ISCMHistoryItem): Promise<ISCMHistoryItem> {
		if (item.tooltip) {
			this.historyDetails.set(item.id, item.tooltip);
			return item;
		}
		const tooltip = await this.prepareHistoryItemDetails(item.id);
		return { ...item, tooltip };
	}

	private prepareHistoryItemDetails(id: string): ISCMHistoryItemDetails | Promise<ISCMHistoryItemDetails> {
		const cached = this.historyDetails.get(id);
		if (cached) return cached;
		// Preparing a page must not exhaust extension invocation slots needed by the rest of the UI.
		const queue = this.detailQueues[this.nextDetailQueue++ % this.detailQueues.length]!;
		const request = queue.schedule(() => {
			this.assertNotDisposed();
			return this.call('history', { methodName: 'resolveHistoryItemDetails', arguments: [id] });
		}).then(parseDetails).then(details => {
			if (!this.isDisposed) this.historyDetails.set(id, details);
			return details;
		}, error => {
			if (this.historyDetails.peek(id) === request) this.historyDetails.delete(id);
			throw error;
		});
		this.historyDetails.set(id, request);
		return request;
	}
	public add(value: {
		dispose(): void;
	}): void { this._register(toDisposable(() => value.dispose())); }
	public get id(): string { return this.snapshot.id; }
	public get hasTimeline(): boolean { return this.snapshot.timeline !== undefined; }
	public get selectionRevision(): number { return this.snapshot.selectionRevision; }
	public get providerId(): string { return this.snapshot.providerId; }
	public get label(): string { return this.snapshot.label; }
	public get rootUri(): URI | undefined { return this.snapshot.rootUri ? URI.parse(this.snapshot.rootUri) : undefined; }
	public get activeRepositoryName(): string | undefined { return this.snapshot.activeRepositoryName; }
	public get statusMessage(): string { return this.snapshot.statusMessage; }
	public get isBusy(): boolean { return this.snapshot.isBusy; }
	public get count(): number | undefined { return this.snapshot.count; }
	public get actionButton(): ISCMActionButtonDescriptor | undefined { return this.snapshot.actionButton; }
	public get input(): ISCMProvider['input'] {
		const owner = this;
		const input = this.snapshot.input;
		return {
			get value() { return owner.draft; }, set value(value: string) {
				if (owner.draft !== value) {
					owner.draft = value;
					++owner.draftRevision;
					void owner.syncInput().catch(owner.reportError);
				}
			},
			visible: input.visible !== false, buttonVisible: input.buttonVisible !== false, validationMessage: optionalString(input.validationMessage),
			placeholder: string(input.placeholder), enabled: input.enabled === true, canAccept: input.canAccept === true,
			buttonLabel: string(input.buttonLabel), buttonTooltip: string(input.buttonTooltip),
			async accept() {
				const revision = owner.draftRevision;
				const result = await owner.call('acceptInput', { value: owner.draft, inputRevision: owner.draftRevision });
				if (owner.draftRevision === revision) {
					owner.draft = string(object(result).value);
					owner.changed.fire();
				}
				return optionalString(object(result).result);
			},
		};
	}
	public get groups(): readonly ISCMResourceGroup[] {
		// Keep resource identities while only input or status presentation changes.
		return this.resourceGroups ??= this.createResourceGroups(this.snapshot.groups);
	}
	private createResourceGroups(groups: ProviderSnapshot['groups'], previous: ProviderSnapshot['groups'] = [], resources: readonly ISCMResourceGroup[] = []): readonly ISCMResourceGroup[] {
		const retained = new Map(previous.map((group, index) => [string(group.id), { snapshot: group, group: resources[index] }]));
		return groups.map(group => {
			const old = retained.get(string(group.id));
			if (old?.group && structuralEquals(old.snapshot, group)) return old.group;
			const previousResources = new Map(old?.group ? array(old.snapshot.resources).map((value, index) => [string(object(value).id), { snapshot: value, resource: old.group!.resources[index] }]) : []);
			return {
				id: string(group.id), label: string(group.label), actions: array(group.actions).map(value => this.action(value)),
				resources: array(group.resources).map(value => {
					const resource = object(value);
					const retained = previousResources.get(string(resource.id));
					if (retained?.resource && structuralEquals(retained.snapshot, value)) return retained.resource;
					const decoration = object(resource.decorations);
					return {
						sourceUri: URI.parse(string(resource.sourceUri)), path: string(resource.path), originalPath: optionalString(resource.originalPath),
						decorations: { badge: string(decoration.badge), tooltip: string(decoration.tooltip), kind: string(decoration.kind) },
						openLabel: string(resource.openLabel), actions: array(resource.actions).map(value => this.action(value)),
						open: async (options, sideBySide) => {
							if (sideBySide) {
								await this.call('open', { resourceId: string(resource.id), options, sideBySide });
								return;
							}
							this.openController?.abort();
							this.openController = undefined;
							// Explicit retained opens must survive a later preview selection.
							if (options.pinned) {
								await this.call('open', { resourceId: string(resource.id), options, sideBySide });
								return;
							}
							const controller = this.openController = new AbortController();
							try {
								await this.call('open', { resourceId: string(resource.id), options, sideBySide }, controller.signal);
							} catch (error) {
								if (!controller.signal.aborted) throw error;
							} finally {
								if (this.openController === controller) this.openController = undefined;
							}
						},
					};
				}),
			};
		});
	}
	public get statusBarCommands(): ISCMProvider['statusBarCommands'] {
		return this.snapshot.statusBarCommands.map(entry => ({
			id: string(entry.id), text: string(entry.text), ariaLabel: string(entry.ariaLabel),
			tooltip: string(entry.tooltip), priority: number(entry.priority), compactGroup: optionalString(entry.compactGroup),
			alignment: entry.alignment === 'right' ? 'right' : 'left',
			icon: entry.icon ? Icon.fromId(string(entry.icon)) : undefined,
			showProgress: entry.showProgress === true,
			run: entry.enabled === false ? undefined : () => this.call('statusBar', { commandId: entry.id }).catch(this.reportError),
		}));
	}
	private action(value: JsonValue): IAction {
		const action = object(value);
		return { id: string(action.id), label: string(action.label), tooltip: string(action.tooltip), enabled: action.enabled === true, checked: typeof action.checked === 'boolean' ? action.checked : undefined, icon: action.icon ? Icon.fromId(string(action.icon)) : undefined, run: () => this.call('action', { actionId: action.id }).catch(this.reportError) };
	}
	public async syncInput(): Promise<void> {
		if (this.syncedDraftRevision === this.draftRevision) {
			return;
		} const revision = this.draftRevision; await this.call('setInput', { value: this.draft, inputRevision: revision }); this.syncedDraftRevision = Math.max(this.syncedDraftRevision, revision);
	}
	public async refresh(): Promise<void> {
		if (this.syncedDraftRevision !== this.draftRevision) await this.syncInput();
		await this.call('refresh', {});
	}
	public async activate(): Promise<void> {
		if (this.syncedDraftRevision !== this.draftRevision) await this.syncInput();
		await this.call('activate', {});
	}
	public accept(value: ProviderSnapshot): void {
		if (value.providerId !== this.providerId || value.rootUri !== this.snapshot.rootUri || value.hasHistory !== this.snapshot.hasHistory || value.hasMerge !== this.snapshot.hasMerge || value.hasHistoryItemRefs !== this.snapshot.hasHistoryItemRefs || value.hasHistoryMergeBase !== this.snapshot.hasHistoryMergeBase) {
			throw new Error('SCM provider identity changed within one registration');
		}
		if (value.inputRevision === this.draftRevision) {
			this.draft = string(value.input.value);
		}
		const historyChanged = value.historyRevision !== this.snapshot.historyRevision;
		const historyRefsChanged = value.historyRefsRevision !== this.snapshot.historyRefsRevision;
		const resourcesChanged = !structuralEquals(value.groups, this.snapshot.groups);
		const timelineChanged = historyChanged || resourcesChanged || !structuralEquals(value.timeline, this.snapshot.timeline);
		if (resourcesChanged && this.resourceGroups) {
			// Reconcile by provider/group/resource identity. Unchanged rows keep their
			// actions and labels; removed rows leave this owner's reachable snapshot.
			this.resourceGroups = this.createResourceGroups(value.groups, this.snapshot.groups, this.resourceGroups);
		}
		this.snapshot = value;
		if (!structuralEquals(this.historyRef.get(), value.historyRef)) { this.historyRef.set(value.historyRef); }
		if (!structuralEquals(this.historyRemoteRef.get(), value.historyRemoteRef)) { this.historyRemoteRef.set(value.historyRemoteRef); }
		if (!structuralEquals(this.historyBaseRef.get(), value.historyBaseRef)) { this.historyBaseRef.set(value.historyBaseRef); }
		this.changed.fire();
		this.decorationChanged.fire([]);
		if (timelineChanged) this.timelineChanged.fire();
		if (historyChanged) { this.historyChanged.fire(); }
		else if (historyRefsChanged) { this.historyRefsChanged.fire(value.historyRefsItems); }
	}
}
function registrationKey(source: ExtensionClientSource, id: string): string { return JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation, id]); }
function object(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected SCM object');
	} return value as Record<string, JsonValue>;
}
function array(value: JsonValue): readonly JsonValue[] {
	if (!Array.isArray(value) || value.length > 100000) {
		throw new TypeError('Expected bounded SCM array');
	} return value;
}
function string(value: JsonValue, limit = 32768): string {
	if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
		throw new TypeError('Invalid SCM text');
	} return value;
}
function optionalString(value: JsonValue | undefined, limit = 32768): string | undefined { return value == null ? undefined : string(value, limit); }
function number(value: JsonValue): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError('Invalid SCM number');
	} return value;
}
function parseRef(value: JsonValue): ISCMHistoryItemRef { const entry = object(value); return { id: string(entry.id), name: string(entry.name), revision: optionalString(entry.revision), category: optionalString(entry.category), description: optionalString(entry.description), upstream: optionalString(entry.upstream), canDelete: entry.canDelete === true, color: entry.color == null ? undefined : number(entry.color) }; }
function parseActions(value: JsonValue): void {
	for (const item of array(value)) {
		const action = object(item);
		string(action.id);
		string(action.label);
		string(action.tooltip);
		optionalString(action.icon);
		if (typeof action.enabled !== 'boolean') {
			throw new TypeError('Invalid SCM action');
		}
	}
}
function parseActionButton(value: JsonValue): ISCMActionButtonDescriptor {
	const entry = object(value);
	if (typeof entry.enabled !== 'boolean') throw new TypeError('Invalid SCM action button availability');
	const command = (value: JsonValue): ISCMActionButtonDescriptor['command'] => {
		const entry = object(value);
		return {
			id: string(entry.id), title: string(entry.title), tooltip: optionalString(entry.tooltip),
			shortTitle: optionalString(entry.shortTitle), arguments: entry.arguments == null ? undefined : [...array(entry.arguments)],
		};
	};
	return {
		command: command(entry.command), enabled: entry.enabled,
		secondaryCommands: entry.secondaryCommands == null ? undefined : array(entry.secondaryCommands).map(group => array(group).map(command)),
	};
}
function parseProvider(value: JsonValue): ProviderSnapshot {
	const entry = object(value);
	for (const key of ['hasHistoryItemRefs', 'hasHistoryMergeBase']) {
		if (entry[key] != null && typeof entry[key] !== 'boolean') { throw new TypeError('Invalid SCM history capability'); }
	}
	if (entry.count != null && (typeof entry.count !== 'number' || !Number.isSafeInteger(entry.count) || entry.count < 0)) throw new TypeError('Invalid SCM count');
	const input = object(entry.input);
	for (const key of ['visible', 'buttonVisible']) {
		if (input[key] != null && typeof input[key] !== 'boolean') throw new TypeError('Invalid SCM input visibility');
	}
	if (input.validationMessage != null) string(input.validationMessage);
	for (const key of ['value', 'placeholder', 'buttonLabel', 'buttonTooltip']) {
		string(input[key]);
	}
	const groups = array(entry.groups).map(object);
	for (const group of groups) {
		string(group.id);
		string(group.label);
		parseActions(group.actions);
		for (const item of array(group.resources)) {
			const resource = object(item);
			string(resource.id);
			string(resource.sourceUri);
			string(resource.path);
			string(resource.openLabel);
			const data = object(resource.decorations);
			string(data.badge);
			string(data.tooltip);
			string(data.kind);
			parseActions(resource.actions);
			URI.parse(string(resource.sourceUri));
		}
	}
	const statusBarCommands = array(entry.statusBarCommands).map(object);
	for (const command of statusBarCommands) {
		string(command.id); string(command.text); string(command.ariaLabel); string(command.tooltip);
		number(command.priority); optionalString(command.icon); optionalString(command.compactGroup);
		if (command.alignment !== undefined && command.alignment !== 'left' && command.alignment !== 'right') {
			throw new TypeError('Invalid SCM status command alignment');
		}
		if (command.enabled !== undefined && typeof command.enabled !== 'boolean') {
			throw new TypeError('Invalid SCM status command availability');
		}
		if (command.showProgress !== undefined && typeof command.showProgress !== 'boolean') {
			throw new TypeError('Invalid SCM status command progress');
		}
	}
	if (entry.rootUri != null) { URI.parse(string(entry.rootUri)); }
	const selectionRevision = entry.selectionRevision == null ? 0 : number(entry.selectionRevision);
	if (!Number.isSafeInteger(selectionRevision) || selectionRevision < 0) { throw new TypeError('Invalid SCM selection revision'); }
	const historyRefsRevision = entry.historyRefsRevision == null ? 0 : number(entry.historyRefsRevision);
	if (!Number.isSafeInteger(historyRefsRevision) || historyRefsRevision < 0) { throw new TypeError('Invalid SCM history refs revision'); }
	const historyRefsItems = entry.historyRefsItems == null ? [] : array(entry.historyRefsItems).map(parseHistoryItem);
	const timeline = entry.timeline == null ? undefined : object(entry.timeline);
	return { actionButton: entry.actionButton == null ? undefined : parseActionButton(entry.actionButton), timeline: timeline ? { label: string(timeline.label), resetKey: optionalString(timeline.resetKey) } : undefined, count: entry.count == null ? undefined : number(entry.count), id: string(entry.id), providerId: string(entry.providerId), label: string(entry.label), rootUri: optionalString(entry.rootUri), selected: entry.selected === true, selectionRevision, groups, input, activeRepositoryName: optionalString(entry.activeRepositoryName), statusMessage: string(entry.statusMessage), isBusy: entry.isBusy === true, statusBarCommands, historyRef: entry.historyRef == null ? undefined : parseRef(entry.historyRef), historyRemoteRef: entry.historyRemoteRef == null ? undefined : parseRef(entry.historyRemoteRef), historyBaseRef: entry.historyBaseRef == null ? undefined : parseRef(entry.historyBaseRef), hasHistoryItemRefs: entry.hasHistoryItemRefs === true, hasHistoryMergeBase: entry.hasHistoryMergeBase === true, historyRevision: number(entry.historyRevision), historyRefsRevision, historyRefsItems, hasHistory: entry.hasHistory === true, hasMerge: entry.hasMerge === true, inputRevision: number(entry.inputRevision), multiDiff: entry.multiDiff == null ? undefined : object(entry.multiDiff) };
}
function parseHistoryItem(value: JsonValue): ISCMHistoryItem { const entry = object(value); return { id: string(entry.id), parentIds: array(entry.parentIds).map(value => string(value)), subject: string(entry.subject), message: string(entry.message, 512 * 1024), displayId: optionalString(entry.displayId), timestamp: entry.timestamp == null ? undefined : number(entry.timestamp), tooltip: entry.tooltip == null ? undefined : parseDetails(entry.tooltip), references: array(entry.references ?? []).map(parseRef), remoteLinks: array(entry.remoteLinks ?? []).map(value => { const link = object(value); return { name: string(link.name), uri: URI.parse(string(link.uri)) }; }) }; }
function parseHistoryChange(value: JsonValue): ISCMHistoryItemChange { const entry = object(value); return { uri: URI.parse(string(entry.uri)), originalUri: entry.originalUri == null ? undefined : URI.parse(string(entry.originalUri)), modifiedUri: entry.modifiedUri == null ? undefined : URI.parse(string(entry.modifiedUri)), path: string(entry.path), originalPath: optionalString(entry.originalPath), status: string(entry.status), parentId: optionalString(entry.parentId) }; }
function encodeChange(change: ISCMHistoryItemChange): Record<string, unknown> { return { ...change, uri: change.uri.toString(), originalUri: change.originalUri?.toString(), modifiedUri: change.modifiedUri?.toString() }; }
function parseDetails(value: JsonValue): ISCMHistoryItemDetails { const entry = object(value); const stats = object(entry.statistics); return { authorName: string(entry.authorName), authorEmail: string(entry.authorEmail), timestamp: number(entry.timestamp), message: string(entry.message, 512 * 1024), statistics: { files: number(stats.files), additions: number(stats.additions), deletions: number(stats.deletions) } }; }
function parseContent(value: JsonValue): ISCMHistoryItemChangeContents['original'] {
	const entry = object(value); if (entry.kind === 'text') {
		return { kind: 'text', text: string(entry.text, 16 * 1024 * 1024) };
	} if (entry.kind === 'binary') {
		if (entry.bytes == null) { return { kind: 'binary' }; }
		if (!Array.isArray(entry.bytes) || entry.bytes.length > 2 * 1024 * 1024 || entry.bytes.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
			throw new TypeError('Invalid SCM binary bytes');
		}
		return { kind: 'binary', bytes: Uint8Array.from(entry.bytes as number[]) };
	} if (entry.kind === 'missing') {
		return { kind: 'missing' };
	} throw new TypeError('Invalid SCM content');
}
function parseContents(value: JsonValue): ISCMHistoryItemChangeContents { const entry = object(value); return { parentId: optionalString(entry.parentId), original: parseContent(entry.original), modified: parseContent(entry.modified) }; }
function parseConflict(value: JsonValue): ISCMConflictFile {
	const entry = object(value); const stageIds = array(entry.stageIds).map(value => value === null ? null : string(value)); if (stageIds.length !== 3) {
		throw new TypeError('Invalid conflict identities');
	} return { stageIds, resultObjectId: entry.resultObjectId === null ? null : string(entry.resultObjectId), base: parseContent(entry.base), current: parseContent(entry.current), incoming: parseContent(entry.incoming), result: parseContent(entry.result) };
}

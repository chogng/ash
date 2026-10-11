import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { observableValue } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { Icon } from '../../../base/common/icon.js';
import type { IAction } from '../../../base/common/actions.js';
import { IExtensionHostApi, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type ExtensionHostSCMRegistration, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { ISCMService, ISCMViewService, type ISCMProvider, type ISCMResourceGroup, type ISCMConflictFile, type ISCMConflictResolution } from '../../contrib/scm/common/scm.js';
import type { ISCMHistoryProvider, ISCMHistoryItem, ISCMHistoryItemRef, ISCMHistoryItemChange, ISCMHistoryItemDetails, ISCMHistoryItemChangeContents } from '../../contrib/scm/common/history.js';
import { IQuickDiffService } from '../../contrib/scm/common/quickDiff.js';
import { IDecorationsService } from '../../services/decorations/common/decorations.js';

class SCMRegistration extends Disposable {
	public revision = 0;
	public readonly providers = this._register(new DisposableMap<string, ExtensionSCMProvider>());
	public readonly controller = new AbortController();
	constructor(public readonly runtime: ExtensionHostRuntime, public readonly registration: ExtensionHostSCMRegistration) {
		super();
		this._register(toDisposable(() => this.controller.abort('SCM extension was retired')));
	}
}

/** SCM owns view state; all repository policy and commands remain in the extension. */
export class MainThreadSCM extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, SCMRegistration>());
	constructor(
		private readonly timeout: number,
		private readonly reportError: (error: unknown) => void,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@ISCMService private readonly scm: ISCMService,
		@ISCMViewService private readonly view: ISCMViewService,
		@IQuickDiffService private readonly quickDiff: IQuickDiffService,
		@IDecorationsService private readonly decorations: IDecorationsService,
	) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const current = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind === 'sourceControl') {
					current.add(registrationKey({ extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation }, registration.registrationId));
				}
			}
		}
		// Retire the old process before its replacement reuses repository identities.
		for (const key of this.registrations.keys()) { if (!current.has(key)) { this.registrations.deleteAndDispose(key); } }
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'sourceControl') { continue; }
				const source = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation };
				const key = registrationKey(source, registration.registrationId);
				if (!this.registrations.has(key)) {
					const owner = this.registrations.set(key, new SCMRegistration(runtime, registration));
					this.set(source, registration.registrationId, registration.revision, registration.providers);
					void this.invoke(owner, 'initialize', {}).catch(this.reportError);
				} else { this.set(source, registration.registrationId, registration.revision, registration.providers); }
			}
		}
	}

	public set(source: ExtensionClientSource, registrationId: string, revision: number, values: readonly JsonValue[]): void {
		this.assertNotDisposed();
		const owner = this.registrations.get(registrationKey(source, registrationId));
		if (!owner) { throw new Error('SCM update belongs to a retired registration'); }
		if (revision <= owner.revision) { return; }
		// Normalize the whole replacement before changing the existing view.
		const snapshots = values.map(parseProvider);
		if (new Set(snapshots.map(value => value.id)).size !== snapshots.length) { throw new TypeError('Duplicate SCM provider'); }
		const current = new Set(snapshots.map(value => value.id));
		for (const id of owner.providers.keys()) { if (!current.has(id)) { owner.providers.deleteAndDispose(id); } }
		for (const value of snapshots) {
			let provider = owner.providers.get(value.id);
			if (!provider) {
				if (this.scm.getRepository(value.id)) { throw new Error('SCM repository identity is already registered'); }
				provider = owner.providers.set(value.id, new ExtensionSCMProvider(value, (method, payload) => this.invoke(owner, method, { providerId: value.id, ...payload }), this.reportError));
				provider.add(this.scm.registerSCMProvider(provider));
				const providerId = `${source.extensionId}:${value.id}`;
				provider.add(this.quickDiff.addProvider({
					id: providerId, label: value.label, rootUri: provider.rootUri, onDidChange: Event.map(provider.onDidChangeResources, () => undefined), provideOriginalResource: async (resource, signal) => {
						const revision = owner.revision;
						const result = await this.invoke(owner, 'quickDiff', { providerId: value.id, resource: resource.toString() }, signal);
						if (result === null) { return undefined; }
						const original = object(result);
						return { providerId, providerLabel: provider!.label, label: provider!.label, originalResource: URI.parse(string(original.resource)), revision, text: string(original.text, 16 * 1024 * 1024) };
					}
				}));
				provider.add(this.decorations.registerDecorationsProvider({
					label: value.label, onDidChange: provider.onDidChangeDecorations, provideDecorations: async resource => {
						const result = await provider!.call('decoration', { resource: resource.toString() });
						if (result === null) { return undefined; }
						const data = object(result);
						return { tooltip: optionalString(data.tooltip), color: optionalString(data.color), letter: optionalString(data.letter), weight: typeof data.weight === 'number' ? data.weight : undefined };
					}
				}));
			} else { provider.accept(value); }
			if (value.selected) { this.view.selectRepository(value.id); }
		}
		owner.revision = revision;
	}

	private async invoke(owner: SCMRegistration, method: string, payload: Record<string, unknown>, callerSignal?: AbortSignal): Promise<JsonValue> {
		const signal = callerSignal ? AbortSignal.any([owner.controller.signal, callerSignal]) : owner.controller.signal;
		signal.throwIfAborted();
		const runtime = owner.runtime;
		const result = await this.api.invoke({ extensionId: runtime.id, incarnation: runtime.incarnation!, activationGeneration: runtime.activationGeneration, registrationId: owner.registration.registrationId, operation: 'scm', payload: normalizeExtensionHostPayload({ method, ...payload }), deadlineUnixMillis: Date.now() + this.timeout }, signal);
		signal.throwIfAborted();
		return result;
	}

	public clear(): void { this.registrations.clearAndDisposeAll(); }
}

interface ProviderSnapshot {
	readonly id: string;
	readonly providerId: string;
	readonly label: string;
	readonly rootUri: string | undefined;
	readonly selected: boolean;
	readonly groups: readonly Record<string, JsonValue>[];
	readonly input: Record<string, JsonValue>;
	readonly activeRepositoryName: string | undefined;
	readonly statusMessage: string;
	readonly isBusy: boolean;
	readonly statusBarCommands: readonly Record<string, JsonValue>[];
	readonly historyRef: ISCMHistoryItemRef | undefined;
	readonly historyRevision: number;
	readonly hasHistory: boolean;
	readonly hasMerge: boolean;
}

class ExtensionSCMProvider extends Disposable implements ISCMProvider {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeResources = this.changed.event;
	private readonly decorationChanged = this._register(new Emitter<readonly URI[]>());
	public readonly onDidChangeDecorations = this.decorationChanged.event;
	private readonly historyChanged = this._register(new Emitter<void>());
	private readonly historyRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	private draft: string;
	private draftRevision = 0;
	public readonly historyProvider: ISCMHistoryProvider | undefined;
	public readonly mergeProvider;
	constructor(private snapshot: ProviderSnapshot, public readonly call: (method: string, payload: Record<string, unknown>) => Promise<JsonValue>, private readonly reportError: (error: unknown) => void) {
		super();
		this.draft = string(snapshot.input.value);
		this.historyRef.set(snapshot.historyRef);
		if (snapshot.hasHistory) {
			this.historyProvider = {
				onDidChange: this.historyChanged.event, historyItemRef: this.historyRef,
				refresh: () => { void this.call('history', { methodName: 'refresh', arguments: [] }).catch(this.reportError); },
				provideHistoryItems: async options => array(await this.call('history', { methodName: 'provideHistoryItems', arguments: [options] })).map(parseHistoryItem),
				resolveHistoryItemDetails: async id => parseDetails(await this.call('history', { methodName: 'resolveHistoryItemDetails', arguments: [id] })),
				provideHistoryItemChanges: async (id, parent) => array(await this.call('history', { methodName: 'provideHistoryItemChanges', arguments: [id, parent ?? null] })).map(parseHistoryChange),
				resolveHistoryItemChangeContents: async (id, change) => parseContents(await this.call('history', { methodName: 'resolveHistoryItemChangeContents', arguments: [id, encodeChange(change)] })),
				resolveHistoryItemChatContext: async id => optionalString(await this.call('history', { methodName: 'resolveHistoryItemChatContext', arguments: [id] }), 512 * 1024),
				resolveHistoryItemChangeRangeChatContext: async (id, parent, path) => optionalString(await this.call('history', { methodName: 'resolveHistoryItemChangeRangeChatContext', arguments: [id, parent, path] }), 512 * 1024),
			};
		}
		this.mergeProvider = snapshot.hasMerge ? {
			resolve: async (path: string): Promise<ISCMConflictFile> => parseConflict(await this.call('merge', { methodName: 'resolve', arguments: [path] })),
			complete: async (path: string, stageIds: readonly (string | null)[], objectId: string | null, resolution: ISCMConflictResolution): Promise<void> => { await this.call('merge', { methodName: 'complete', arguments: [path, stageIds, objectId, resolution] }); },
			errorMessage: (error: unknown): string => String(error),
		} : undefined;
	}
	public add(value: { dispose(): void; }): void { this._register(toDisposable(() => value.dispose())); }
	public get id(): string { return this.snapshot.id; }
	public get providerId(): string { return this.snapshot.providerId; }
	public get label(): string { return this.snapshot.label; }
	public get rootUri(): URI | undefined { return this.snapshot.rootUri ? URI.parse(this.snapshot.rootUri) : undefined; }
	public get activeRepositoryName(): string | undefined { return this.snapshot.activeRepositoryName; }
	public get statusMessage(): string { return this.snapshot.statusMessage; }
	public get isBusy(): boolean { return this.snapshot.isBusy; }
	public get input(): ISCMProvider['input'] {
		const owner = this;
		const input = this.snapshot.input;
		return {
			get value() { return owner.draft; }, set value(value: string) { if (owner.draft !== value) { owner.draft = value; ++owner.draftRevision; } },
			placeholder: string(input.placeholder), enabled: input.enabled === true, canAccept: input.canAccept === true,
			buttonLabel: string(input.buttonLabel), buttonTooltip: string(input.buttonTooltip),
			async accept() {
				const revision = owner.draftRevision;
				const result = await owner.call('acceptInput', { value: owner.draft });
				if (owner.draftRevision === revision) { owner.draft = string(object(result).value); owner.changed.fire(); }
				return optionalString(object(result).result);
			},
		};
	}
	public get groups(): readonly ISCMResourceGroup[] {
		return this.snapshot.groups.map(group => ({
			id: string(group.id), label: string(group.label), actions: array(group.actions).map(value => this.action(value)),
			resources: array(group.resources).map(value => {
				const resource = object(value);
				const decoration = object(resource.decorations);
				return {
					sourceUri: URI.parse(string(resource.sourceUri)), path: string(resource.path), originalPath: optionalString(resource.originalPath),
					decorations: { badge: string(decoration.badge), tooltip: string(decoration.tooltip), kind: string(decoration.kind) },
					openLabel: string(resource.openLabel), actions: array(resource.actions).map(value => this.action(value)),
					open: async (options, sideBySide) => { await this.call('open', { resourceId: string(resource.id), options, sideBySide }); },
				};
			}),
		}));
	}
	public get statusBarCommands(): ISCMProvider['statusBarCommands'] {
		return this.snapshot.statusBarCommands.map(entry => ({ id: string(entry.id), text: string(entry.text), ariaLabel: string(entry.ariaLabel), tooltip: string(entry.tooltip), priority: number(entry.priority), compactGroup: optionalString(entry.compactGroup), icon: entry.icon ? Icon.fromId(string(entry.icon)) : undefined, run: () => this.call('statusBar', { commandId: entry.id }).catch(this.reportError) }));
	}
	private action(value: JsonValue): IAction {
		const action = object(value);
		return { id: string(action.id), label: string(action.label), tooltip: string(action.tooltip), enabled: action.enabled === true, checked: typeof action.checked === 'boolean' ? action.checked : undefined, icon: action.icon ? Icon.fromId(string(action.icon)) : undefined, run: () => this.call('action', { actionId: action.id }).catch(this.reportError) };
	}
	public async refresh(): Promise<void> { await this.call('refresh', { value: this.draft }); }
	public async activate(): Promise<void> { await this.call('activate', { value: this.draft }); }
	public accept(value: ProviderSnapshot): void {
		if (value.providerId !== this.providerId || value.rootUri !== this.snapshot.rootUri || value.hasHistory !== this.snapshot.hasHistory || value.hasMerge !== this.snapshot.hasMerge) { throw new Error('SCM provider identity changed within one registration'); }
		const historyChanged = value.historyRevision !== this.snapshot.historyRevision;
		this.snapshot = value;
		this.historyRef.set(value.historyRef);
		this.changed.fire();
		this.decorationChanged.fire([]);
		if (historyChanged) { this.historyChanged.fire(); }
	}
}

function registrationKey(source: ExtensionClientSource, id: string): string { return JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation, id]); }
function object(value: JsonValue): Record<string, JsonValue> { if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError('Expected SCM object'); } return value as Record<string, JsonValue>; }
function array(value: JsonValue): readonly JsonValue[] { if (!Array.isArray(value) || value.length > 100_000) { throw new TypeError('Expected bounded SCM array'); } return value; }
function string(value: JsonValue, limit = 32768): string { if (typeof value !== 'string' || value.length > limit || value.includes('\0')) { throw new TypeError('Invalid SCM text'); } return value; }
function optionalString(value: JsonValue | undefined, limit = 32768): string | undefined { return value == null ? undefined : string(value, limit); }
function number(value: JsonValue): number { if (typeof value !== 'number' || !Number.isFinite(value)) { throw new TypeError('Invalid SCM number'); } return value; }
function parseRef(value: JsonValue): ISCMHistoryItemRef { const entry = object(value); return { id: string(entry.id), name: string(entry.name), revision: optionalString(entry.revision), category: optionalString(entry.category), description: optionalString(entry.description), upstream: optionalString(entry.upstream), canDelete: entry.canDelete === true, color: entry.color == null ? undefined : number(entry.color) }; }
function parseProvider(value: JsonValue): ProviderSnapshot {
	const entry = object(value);
	const input = object(entry.input);
	for (const key of ['value', 'placeholder', 'buttonLabel', 'buttonTooltip']) { string(input[key]); }
	const groups = array(entry.groups).map(object);
	for (const group of groups) {
		string(group.id); string(group.label); array(group.actions);
		for (const item of array(group.resources)) { const resource = object(item); string(resource.id); string(resource.sourceUri); string(resource.path); string(resource.openLabel); const data = object(resource.decorations); string(data.badge); string(data.tooltip); string(data.kind); array(resource.actions); }
	}
	return { id: string(entry.id), providerId: string(entry.providerId), label: string(entry.label), rootUri: optionalString(entry.rootUri), selected: entry.selected === true, groups, input, activeRepositoryName: optionalString(entry.activeRepositoryName), statusMessage: string(entry.statusMessage), isBusy: entry.isBusy === true, statusBarCommands: array(entry.statusBarCommands).map(object), historyRef: entry.historyRef == null ? undefined : parseRef(entry.historyRef), historyRevision: number(entry.historyRevision), hasHistory: entry.hasHistory === true, hasMerge: entry.hasMerge === true };
}
function parseHistoryItem(value: JsonValue): ISCMHistoryItem { const entry = object(value); return { id: string(entry.id), parentIds: array(entry.parentIds).map(value => string(value)), subject: string(entry.subject), message: string(entry.message, 512 * 1024), displayId: optionalString(entry.displayId), timestamp: entry.timestamp == null ? undefined : number(entry.timestamp), references: array(entry.references ?? []).map(parseRef), remoteLinks: array(entry.remoteLinks ?? []).map(value => { const link = object(value); return { name: string(link.name), uri: URI.parse(string(link.uri)) }; }) }; }
function parseHistoryChange(value: JsonValue): ISCMHistoryItemChange { const entry = object(value); return { uri: URI.parse(string(entry.uri)), originalUri: entry.originalUri == null ? undefined : URI.parse(string(entry.originalUri)), modifiedUri: entry.modifiedUri == null ? undefined : URI.parse(string(entry.modifiedUri)), path: string(entry.path), originalPath: optionalString(entry.originalPath), status: string(entry.status), parentId: optionalString(entry.parentId) }; }
function encodeChange(change: ISCMHistoryItemChange): Record<string, unknown> { return { ...change, uri: change.uri.toString(), originalUri: change.originalUri?.toString(), modifiedUri: change.modifiedUri?.toString() }; }
function parseDetails(value: JsonValue): ISCMHistoryItemDetails { const entry = object(value); const stats = object(entry.statistics); return { authorName: string(entry.authorName), authorEmail: string(entry.authorEmail), timestamp: number(entry.timestamp), message: string(entry.message, 512 * 1024), statistics: { files: number(stats.files), additions: number(stats.additions), deletions: number(stats.deletions) } }; }
function parseContent(value: JsonValue): ISCMHistoryItemChangeContents['original'] { const entry = object(value); if (entry.kind === 'text') { return { kind: 'text', text: string(entry.text, 16 * 1024 * 1024) }; } if (entry.kind === 'binary' || entry.kind === 'missing') { return { kind: entry.kind }; } throw new TypeError('Invalid SCM content'); }
function parseContents(value: JsonValue): ISCMHistoryItemChangeContents { const entry = object(value); return { parentId: optionalString(entry.parentId), original: parseContent(entry.original), modified: parseContent(entry.modified) }; }
function parseConflict(value: JsonValue): ISCMConflictFile { const entry = object(value); const stageIds = array(entry.stageIds).map(value => value === null ? null : string(value)); if (stageIds.length !== 3) { throw new TypeError('Invalid conflict identities'); } return { stageIds, resultObjectId: entry.resultObjectId === null ? null : string(entry.resultObjectId), base: parseContent(entry.base), current: parseContent(entry.current), incoming: parseContent(entry.incoming), result: parseContent(entry.result) }; }

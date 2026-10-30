import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { derived, observableValue } from '../../../../base/common/observable.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserViewStorageScope, IBrowserViewService, normalizeBrowserViewUrl, type BrowserViewEvent, type IBrowserViewInfo } from '../../../../platform/browserView/common/browserView.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { canvasOwnerKey, type ICanvas, type ICanvasContext, type ICanvasDefinition, type ICanvasOpenRequest, type ICanvasOwner } from './canvas.js';
import type { IAgentCanvasHost, IAgentCanvasOpenRequest } from '../../../../platform/agentHost/common/agentService.js';

export interface ICanvasProvider {
	readonly definition: ICanvasDefinition;
	readonly signal: AbortSignal;
	open(owner: ICanvasOwner, instanceId: string, signal: AbortSignal): Promise<{ readonly url: string; readonly title?: string; readonly status?: string; }>;
	close(owner: ICanvasOwner, instanceId: string, signal: AbortSignal): Promise<void>;
	resolve?(owner: ICanvasOwner, instanceId: string, signal: AbortSignal): Promise<CanvasSource | null | undefined | 'unchanged'>;
}

interface CanvasSource { readonly url: string; readonly title?: string; readonly status?: string; }

export const IAgentHostCanvasCollection = createServiceIdentifier<IAgentHostCanvasCollection>('agentHostCanvasCollection');
export interface IAgentHostCanvasCollection extends IAgentCanvasHost {
	beginDefinitionRefresh(): IDisposable;
	register(provider: ICanvasProvider): IDisposable;
	suspendProvider(provider: ICanvasProvider): void;
	retireExtension(extensionId: string): void;
	settleExtension(extensionId: string): void;
	reconcileExtensions(present: ReadonlySet<string>): void;
	createContext(owner: ICanvasOwner): ICanvasContext;
	removeOwner(owner: ICanvasOwner): void;
	refreshProvider(provider: ICanvasProvider): Promise<void>;
}

/** A read projection of Main's live pages and the admitted extension fleet. Providers own their web applications. */
export class AgentHostCanvasCollection extends Disposable implements IAgentHostCanvasCollection {
	private readonly changed = this._register(new Emitter<void>());
	private readonly providers = new Map<string, ICanvasProvider>();
	private readonly suspended = new Map<string, ICanvasProvider['definition']>();
	private readonly pages = observableValue<readonly IBrowserViewInfo[] | undefined>(this, undefined);
	private readonly requests = observableValue<ReadonlyMap<string, ReadonlyMap<string, ICanvasOpenRequest>>>(this, new Map());
	private readonly contexts = new Map<string, ICanvasContext>();
	private readonly ownerControllers = new Map<string, AbortController>();
	private readonly buffered: BrowserViewEvent[] = [];
	private readonly operations = new Map<string, Promise<void>>();
	private readonly presentations = observableValue<ReadonlyMap<string, CanvasSource | undefined>>(this, new Map());
	private readonly providerRevisions = new Map<ICanvasProvider, number>();
	private readonly disconnectedPages = new Set<string>();
	// Compare confirmed sources independently of the page's current route, including across hydration.
	private readonly sourceHashes = new Map<string, string>();
	private initialized = false;
	private definitionLoads = 0;

	beginDefinitionRefresh(): IDisposable {
		this.definitionLoads++;
		this.changed.fire();
		return toDisposable(() => { this.definitionLoads--; this.changed.fire(); });
	}

	constructor(@IBrowserViewService private readonly browser: IBrowserViewService, @IExtensionService private readonly extensions: IExtensionService) {
		super();
		this._register(browser.onDidEvent(event => {
			if (!this.initialized) { this.buffered.push(event); } else { this.accept(event); }
		}));
		void browser.getBrowserViews().then(snapshot => {
			if (this.isDisposed) { return; }
			for (const page of snapshot) { this.hideUnknownSource(page); }
			this.pages.set(snapshot.filter(page => page.canvas), undefined);
			this.initialized = true;
			for (const event of this.buffered.splice(0)) { this.accept(event); }
		}, () => {
			if (this.isDisposed) { return; }
			this.initialized = true;
			for (const event of this.buffered.splice(0)) { this.accept(event); }
		});
	}

	register(provider: ICanvasProvider): IDisposable {
		const key = JSON.stringify([provider.definition.extensionId, provider.definition.canvasId]);
		if (this.providers.has(key)) { throw new Error('Canvas provider is already registered'); }
		this.providers.set(key, provider);
		this.suspended.delete(key);
		this.changed.fire();
		return toDisposable(() => {
			if (this.providers.get(key) !== provider) { return; }
			this.providers.delete(key);
			this.providerRevisions.delete(provider);
			this.changed.fire();
			for (const page of this.pages.get() ?? []) {
				if (page.canvas?.extensionId === provider.definition.extensionId && page.canvas.canvasId === provider.definition.canvasId) {
					void this.browser.destroyBrowserView(page.id).catch(() => { });
				}
			}
		});
	}

	/** A disconnected provider has unknown membership. Keep opaque live identities, but never expose its old source. */
	suspendProvider(provider: ICanvasProvider): void {
		const key = JSON.stringify([provider.definition.extensionId, provider.definition.canvasId]);
		if (this.providers.get(key) !== provider) { return; }
		this.providers.delete(key);
		this.providerRevisions.delete(provider);
		this.suspended.set(key, provider.definition);
		const presentations = new Map(this.presentations.get());
		for (const page of this.pages.get() ?? []) {
			if (page.canvas?.extensionId === provider.definition.extensionId && page.canvas.canvasId === provider.definition.canvasId) { presentations.set(page.id, undefined); this.disconnectedPages.add(page.id); }
		}
		this.presentations.set(presentations, undefined);
		this.changed.fire();
	}

	retireExtension(extensionId: string): void {
		for (const [key, definition] of this.suspended) { if (definition.extensionId === extensionId) { this.suspended.delete(key); } }
		for (const page of this.pages.get() ?? []) { if (page.canvas?.extensionId === extensionId) { void this.browser.destroyBrowserView(page.id).catch(() => { }); } }
		this.changed.fire();
	}

	settleExtension(extensionId: string): void {
		let changed = false;
		for (const [key, definition] of this.suspended) {
			if (definition.extensionId !== extensionId || this.providers.has(key)) { continue; }
			this.suspended.delete(key);
			changed = true;
			for (const page of this.pages.get() ?? []) {
				if (page.canvas?.extensionId === extensionId && page.canvas.canvasId === definition.canvasId) {
					void this.browser.destroyBrowserView(page.id).catch(() => { });
				}
			}
		}
		if (changed) { this.changed.fire(); }
		for (const page of this.pages.get() ?? []) {
			if (page.canvas?.extensionId === extensionId && this.disconnectedPages.has(page.id) && !this.providers.has(JSON.stringify([extensionId, page.canvas.canvasId]))) {
				void this.browser.destroyBrowserView(page.id).catch(() => { });
			}
		}
	}

	reconcileExtensions(present: ReadonlySet<string>): void {
		for (const extensionId of new Set((this.pages.get() ?? []).flatMap(page => page.canvas?.extensionId ? [page.canvas.extensionId] : []))) {
			if (!present.has(extensionId)) { this.retireExtension(extensionId); }
		}
	}

	createContext(owner: ICanvasOwner): ICanvasContext {
		const key = canvasOwnerKey(owner);
		let context = this.contexts.get(key);
		if (!context) {
			this.ownerControllers.set(key, new AbortController());
			context = {
				owner,
				canvases: derived(reader => {
					const presentations = this.presentations.read(reader);
					return this.pages.read(reader)?.filter(page => this.owns(page, owner)).map(page => new AgentHostCanvas(page, presentations.has(page.id) ? presentations.get(page.id) ?? null : undefined));
				}),
				openRequests: derived(reader => this.requests.read(reader).get(key) ?? new Map()),
				definitionProvider: owner.providerId !== 'local-agent-host' ? undefined : {
					onDidChangeDefinitions: this.changed.event,
					listCanvases: async () => {
						await this.extensions.activateByEvent('onCanvas');
						if (this.isDisposed) { throw new CancellationError(); }
						if (this.definitionLoads || this.suspended.size) { return undefined; }
						return [...this.providers.values()].filter(provider => !provider.signal.aborted).map(provider => provider.definition);
					},
					openCanvas: (definition, instanceId) => this.open(owner, definition, instanceId),
				},
				closeCanvas: canvas => this.close(owner, canvas),
			};
			this.contexts.set(key, context);
		}
		return context;
	}

	async listCanvases(sessionId: string, threadId: string, signal: AbortSignal) {
		const definitions = await this.createContext(this.owner(sessionId, threadId)).definitionProvider!.listCanvases();
		signal.throwIfAborted();
		return definitions?.map(definition => ({ id: { extensionId: definition.extensionId, canvasId: definition.canvasId }, displayName: definition.displayName, description: definition.description, requiresInput: definition.requiresInput }));
	}

	async openCanvasSource(request: IAgentCanvasOpenRequest, signal: AbortSignal): Promise<CanvasSource> {
		await this.extensions.activateByEvent('onCanvas');
		signal.throwIfAborted();
		const provider = this.providers.get(JSON.stringify([request.definition.extensionId, request.definition.canvasId]));
		if (!provider || provider.signal.aborted || provider.definition.requiresInput) { throw new Error('CanvasProviderUnavailable'); }
		const owner = this.owner(request.sessionId, request.threadId);
		const ownerSignal = this.ownerControllers.get(canvasOwnerKey(owner))?.signal;
		const operationSignal = AbortSignal.any([signal, provider.signal, ...(ownerSignal ? [ownerSignal] : [])]);
		const source = await provider.open(owner, request.instanceId, operationSignal);
		operationSignal.throwIfAborted();
		provider.signal.throwIfAborted();
		return { ...source, title: source.title ?? provider.definition.displayName };
	}

	async closeCanvasSource(threadId: string, targetId: string, signal: AbortSignal): Promise<void> {
		const page = this.pages.get()?.find(page => page.id === targetId && page.owner.type === 'agent' && page.owner.sessionId === threadId);
		if (!page?.canvas?.extensionId || !page.canvas.canvasId) { return; }
		const provider = this.providers.get(JSON.stringify([page.canvas.extensionId, page.canvas.canvasId]));
		if (provider) { await provider.close(this.owner(page.canvas.sessionId, threadId), page.canvas.instanceId, AbortSignal.any([signal, provider.signal])); }
	}

	acceptCanvasOpen(request: { sessionId: string; threadId: string; instanceId: string; }, state: ICanvasOpenRequest, source?: CanvasSource): void {
		const owner = this.owner(request.sessionId, request.threadId);
		this.createContext(owner);
		if (state.succeeded && source) {
			const page = this.pages.get()?.find(page => this.owns(page, owner) && page.canvas?.instanceId === request.instanceId);
			if (page) { this.setPresentation(page.id, source); }
		}
		this.setRequest(owner, request.instanceId, state);
	}

	private owner(sessionId: string, threadId: string): ICanvasOwner {
		return { providerId: 'local-agent-host', session: URI.from({ scheme: 'ash-session', path: '/' + sessionId }), chat: URI.from({ scheme: 'ash-thread', path: '/' + threadId }) };
	}

	removeOwner(owner: ICanvasOwner): void {
		const key = canvasOwnerKey(owner);
		this.ownerControllers.get(key)?.abort();
		this.ownerControllers.delete(key);
		this.contexts.delete(key);
		const requests = new Map(this.requests.get());
		requests.delete(key);
		this.requests.set(requests, undefined);
		for (const page of this.pages.get() ?? []) { if (this.owns(page, owner)) { void this.browser.destroyBrowserView(page.id).catch(() => { }); } }
	}

	async refreshProvider(provider: ICanvasProvider): Promise<void> {
		const revision = (this.providerRevisions.get(provider) ?? 0) + 1;
		this.providerRevisions.set(provider, revision);
		this.changed.fire();
		if (!provider.resolve) { return; }
		await Promise.all((this.pages.get() ?? []).filter(page => page.canvas?.extensionId === provider.definition.extensionId && page.canvas.canvasId === provider.definition.canvasId).map(async page => {
			const thread = page.owner.type === 'agent' ? page.owner.sessionId : page.canvas!.threadId!;
			const owner = this.owner(page.canvas!.sessionId, thread);
			const ownerSignal = this.ownerControllers.get(canvasOwnerKey(owner))?.signal;
			const signal = ownerSignal ? AbortSignal.any([provider.signal, ownerSignal]) : provider.signal;
			let source = await provider.resolve!(owner, page.canvas!.instanceId, signal);
			if (source === 'unchanged' && this.disconnectedPages.has(page.id)) {
				// A new provider incarnation must confirm a source before an old page can be presented again.
				source = await provider.open(owner, page.canvas!.instanceId, signal);
			}
			if (this.isDisposed || signal.aborted || this.providerRevisions.get(provider) !== revision || !this.pages.get()?.some(current => current.id === page.id)) { return; }
			if (source === 'unchanged') { return; }
			if (source === null) { await this.browser.destroyBrowserView(page.id); return; }
			if (source && !this.hasSource(page, source.url)) { await this.browser.loadURL(page.id, normalizeBrowserViewUrl(source.url)); }
			if (signal.aborted || this.providerRevisions.get(provider) !== revision || !this.pages.get()?.some(current => current.id === page.id)) { return; }
			if (source) { this.disconnectedPages.delete(page.id); }
			this.setPresentation(page.id, source);
		}));
	}

	private owns(page: IBrowserViewInfo, owner: ICanvasOwner): boolean {
		return owner.providerId === 'local-agent-host' && page.canvas?.sessionId === owner.session.path.slice(1)
			&& (page.owner.type === 'agent' ? page.owner.sessionId : page.canvas.threadId) === owner.chat.path.slice(1);
	}

	private open(owner: ICanvasOwner, definition: ICanvasDefinition, instanceId: string): Promise<void> {
		const context = this.contexts.get(canvasOwnerKey(owner));
		const ownerSignal = this.ownerControllers.get(canvasOwnerKey(owner))?.signal;
		const operationKey = JSON.stringify([canvasOwnerKey(owner), instanceId]);
		const pending = this.operations.get(operationKey) ?? Promise.resolve();
		const opening = pending.catch(() => { }).then(async () => {
			const provider = this.providers.get(JSON.stringify([definition.extensionId, definition.canvasId]));
			if (!provider || provider.signal.aborted || definition.requiresInput || !context || this.contexts.get(canvasOwnerKey(owner)) !== context) { throw new CancellationError(); }
			this.providerRevisions.set(provider, (this.providerRevisions.get(provider) ?? 0) + 1);
			const request = { id: crypto.randomUUID(), succeeded: false };
			this.setRequest(owner, instanceId, request);
			const signal = ownerSignal ? AbortSignal.any([ownerSignal, provider.signal]) : provider.signal;
			const source = await provider.open(owner, instanceId, signal);
			this.providerRevisions.set(provider, (this.providerRevisions.get(provider) ?? 0) + 1);
			signal.throwIfAborted();
			if (this.isDisposed || this.contexts.get(canvasOwnerKey(owner)) !== context || this.providers.get(JSON.stringify([definition.extensionId, definition.canvasId])) !== provider) { throw new CancellationError(); }
			const url = normalizeBrowserViewUrl(source.url);
			if (url === 'about:blank') { throw new TypeError('Canvas requires an HTTP or HTTPS source'); }
			const existing = this.pages.get()?.find(page => this.owns(page, owner) && page.canvas?.instanceId === instanceId && page.canvas.extensionId === definition.extensionId && page.canvas.canvasId === definition.canvasId);
			if (existing && (existing.owner.type === 'user' || this.hasSource(existing, url))) {
				if (!this.hasSource(existing, url)) { await this.browser.loadURL(existing.id, url); }
				this.setPresentation(existing.id, source);
			}
			else {
				// A user-selected extension page has user navigation authority, isolated from normal browser storage.
				const info = await this.browser.getOrCreateBrowserView('browser_target_' + crypto.randomUUID(), {
					initialUrl: url, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Ephemeral },
					canvas: {
						sessionId: owner.session.path.slice(1), threadId: owner.chat.path.slice(1), instanceId, title: source.title ?? definition.displayName,
						extensionId: definition.extensionId, canvasId: definition.canvasId
					},
				});
				if (provider.signal.aborted || this.isDisposed || this.contexts.get(canvasOwnerKey(owner)) !== context) { await this.browser.destroyBrowserView(info.id); throw new CancellationError(); }
				// User navigation cannot extend an Agent execution's network lease. Replace that page when its source changes.
				if (existing) { await this.browser.destroyBrowserView(existing.id); }
				this.setPresentation(info.id, source);
			}
			this.setRequest(owner, instanceId, { ...request, succeeded: true });
		});
		this.operations.set(operationKey, opening);
		void opening.finally(() => { if (this.operations.get(operationKey) === opening) { this.operations.delete(operationKey); } }).catch(() => { });
		return opening;
	}

	private async close(owner: ICanvasOwner, canvas: ICanvas): Promise<void> {
		const page = this.pages.get()?.find(page => page.id === canvas.resource.path.slice(1) && this.owns(page, owner));
		if (!page?.canvas) { throw new CancellationError(); }
		const provider = this.providers.get(JSON.stringify([page.canvas.extensionId, page.canvas.canvasId]));
		if (provider && canvas.instanceId) { await provider.close(owner, canvas.instanceId, provider.signal); }
		await this.browser.destroyBrowserView(page.id);
	}

	private setRequest(owner: ICanvasOwner, instanceId: string, request: ICanvasOpenRequest): void {
		const all = new Map(this.requests.get());
		all.set(canvasOwnerKey(owner), new Map(all.get(canvasOwnerKey(owner))).set(instanceId, request));
		this.requests.set(all, undefined);
	}

	private sourceHash(url: string): string { const hash = new StringSHA1(); hash.update(normalizeBrowserViewUrl(url)); return hash.digest(); }
	private hasSource(page: IBrowserViewInfo, url: string): boolean { return this.sourceHashes.get(page.id) === this.sourceHash(url) || !this.sourceHashes.has(page.id) && page.state.url === normalizeBrowserViewUrl(url); }
	private setPresentation(id: string, source: CanvasSource | undefined): void {
		if (source) { this.sourceHashes.set(id, this.sourceHash(source.url)); }
		this.presentations.set(new Map(this.presentations.get()).set(id, source), undefined);
	}

	private hideUnknownSource(page: IBrowserViewInfo): void {
		if (page.canvas?.extensionId && !this.providers.has(JSON.stringify([page.canvas.extensionId, page.canvas.canvasId]))) {
			this.disconnectedPages.add(page.id);
			this.presentations.set(new Map(this.presentations.get()).set(page.id, undefined), undefined);
		}
	}

	private accept(event: BrowserViewEvent): void {
		const pages = this.pages.get() ?? [];
		if ((event.type === 'created' || event.type === 'canvasOpened') && event.info.canvas) {
			this.hideUnknownSource(event.info);
			if (event.type === 'canvasOpened' && event.info.canvas.extensionId && this.providers.has(JSON.stringify([event.info.canvas.extensionId, event.info.canvas.canvasId]))) {
				this.disconnectedPages.delete(event.info.id);
				this.setPresentation(event.info.id, { url: event.info.state.url, title: event.info.canvas.title });
			}
			this.pages.set([...pages.filter(page => page.id !== event.info.id), event.info], undefined);
			if (event.type === 'canvasOpened') {
				const thread = event.info.owner.type === 'agent' ? event.info.owner.sessionId : event.info.canvas.threadId;
				if (thread) {
					const owner = this.owner(event.info.canvas.sessionId, thread);
					// The typed renderer host publishes pending before navigation. Native-only callers have no pending request.
					const previous = this.requests.get().get(canvasOwnerKey(owner))?.get(event.info.canvas.instanceId);
					if (!previous || previous.succeeded) { this.setRequest(owner, event.info.canvas.instanceId, { id: crypto.randomUUID(), succeeded: true }); }
				}
			}
		} else if (event.type === 'stateChanged' && pages.some(page => page.id === event.state.targetId)) {
			this.pages.set(pages.map(page => page.id === event.state.targetId ? { ...page, state: event.state } : page), undefined);
		} else if (event.type === 'closed') {
			this.sourceHashes.delete(event.targetId);
			this.disconnectedPages.delete(event.targetId);
			const page = pages.find(page => page.id === event.targetId);
			this.pages.set(pages.filter(page => page.id !== event.targetId), undefined);
			if (page?.canvas) {
				const thread = page.owner.type === 'agent' ? page.owner.sessionId : page.canvas.threadId;
				if (thread) {
					const key = canvasOwnerKey(this.owner(page.canvas.sessionId, thread));
					const all = new Map(this.requests.get());
					const requests = new Map(all.get(key));
					requests.delete(page.canvas.instanceId);
					if (requests.size) { all.set(key, requests); } else { all.delete(key); }
					this.requests.set(all, undefined);
				}
			}
			const presentations = new Map(this.presentations.get()); presentations.delete(event.targetId); this.presentations.set(presentations, undefined);
		}
	}

	protected override disposeCore(): void {
		for (const controller of this.ownerControllers.values()) { controller.abort(); }
		this.ownerControllers.clear();
		this.contexts.clear();
		super.disposeCore();
	}
}

export class AgentHostCanvas implements ICanvas {
	readonly resource: URI;
	readonly instanceId: string | undefined;
	readonly title: string;
	readonly source: URI | undefined;
	readonly status: string | undefined;
	constructor(info: IBrowserViewInfo, presentation?: CanvasSource | null) {
		this.resource = URI.from({ scheme: 'agent-host-canvas', path: '/' + info.id });
		this.instanceId = info.canvas?.instanceId;
		this.title = presentation?.title ?? info.canvas?.title ?? info.state.title;
		this.status = presentation?.status;
		try { const url = normalizeBrowserViewUrl(presentation?.url ?? info.state.url); this.source = presentation === null || url === 'about:blank' ? undefined : URI.parse(url); } catch { this.source = undefined; }
	}
}

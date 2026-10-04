import type { BrowserWindow, WebContentsView, Session } from 'electron/main';
import { createHash, randomUUID } from 'node:crypto';
import { Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { createServiceIdentifier, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { BrowserViewStorageScope, type IBrowserViewService, type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewCreateOptions, type IBrowserViewInfo, normalizeBrowserViewUrl } from '../common/browserView.js';
import { IBrowserViewNavigationResolver } from '../common/browserViewNavigation.js';
import { BrowserView } from './browserView.js';
import { BrowserSession } from './browserSession.js';

export const IBrowserViewMainService = createServiceIdentifier<IBrowserViewMainService>('browserViewMainService');
export interface IBrowserViewMainService extends IBrowserViewService {
	tryGetBrowserView(id: string): BrowserView | undefined;
	createTarget(url: string, sessionId: string, signal: AbortSignal): Promise<BrowserView>;
	validateAgentAccess(id: string, sessionId: string): BrowserView;
}
export interface BrowserViewMainServiceOptions {
	readonly window: BrowserWindow;
	readonly getWorkspaceId: () => string;
	readonly createSession: (partition: string) => Session;
	readonly createView: (session: Session) => WebContentsView;
}
/** The window manager is the sole table of live pages; each page owns its own disposal. */
export class BrowserViewMainService extends Disposable implements IBrowserViewMainService {
	private readonly targets = this._register(new DisposableMap<string, BrowserView>());
	private readonly events = this._register(new Emitter<BrowserViewEvent>());
	readonly onDidEvent = this.events.event;
	private readonly cancellation = new AbortController();
	private readonly creations = new Map<string, Promise<BrowserView>>();
	constructor(private readonly options: BrowserViewMainServiceOptions,
		@IBrowserViewNavigationResolver private readonly navigationResolver: IBrowserViewNavigationResolver,
		@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this._register(toDisposable(() => this.cancellation.abort(new Error('BrowserCapabilityUnavailable'))));
	}
	tryGetBrowserView(id: string): BrowserView | undefined {
		const view = this.targets.get(id);
		return view && !view.webContents.isDestroyed() && !view.signal.aborted ? view : undefined;
	}
	private target(id: string): BrowserView {
		const view = this.tryGetBrowserView(id);
		if (!view) throw new Error('BrowserTargetUnavailable');
		return view;
	}
	public async getBrowserViews(): Promise<readonly IBrowserViewInfo[]> {
		return [...this.targets].map(([, view]) => view.getInfo());
	}
	public async getOrCreateBrowserView(id: string, options: IBrowserViewCreateOptions): Promise<IBrowserViewInfo> {
		return (await this.getOrCreate(id, options, this.cancellation.signal)).getInfo();
	}
	public createTarget(url: string, sessionId: string, signal: AbortSignal): Promise<BrowserView> {
		return this.getOrCreate('browser_target_' + randomUUID(), {
			initialUrl: url,
			owner: { type: 'agent', sessionId },
			session: { scope: BrowserViewStorageScope.Agent, affinity: sessionId },
		}, signal);
	}
	public validateAgentAccess(id: string, sessionId: string): BrowserView {
		const view = this.target(id);
		const owner = view.getInfo().owner;
		if (owner.type !== 'agent' || owner.sessionId !== sessionId) {
			throw new Error('BrowserTargetAccessDenied');
		}
		return view;
	}
	private getOrCreate(id: string, options: IBrowserViewCreateOptions, signal: AbortSignal): Promise<BrowserView> {
		const view = this.tryGetBrowserView(id);
		if (view) {
			return Promise.resolve(view);
		}
		const pending = this.creations.get(id);
		if (pending) return pending;
		const creation = this.create(id, options, signal);
		this.creations.set(id, creation);
		void creation.then(() => this.creations.delete(id), () => this.creations.delete(id));
		return creation;
	}
	private async create(id: string, options: IBrowserViewCreateOptions, requestSignal: AbortSignal): Promise<BrowserView> {
		const signal = AbortSignal.any([requestSignal, this.cancellation.signal]);
		signal.throwIfAborted();
		const navigation = await this.navigationResolver.resolve(normalizeBrowserViewUrl(options.initialUrl), signal);
		if (signal.aborted) { navigation.release(); signal.throwIfAborted(); }
		let view: BrowserView;
		try {
			const storage = options.session;
			let identity: string;
			switch (storage.scope) {
				case BrowserViewStorageScope.Global: identity = 'global'; break;
				case BrowserViewStorageScope.Workspace: identity = 'workspace:' + this.options.getWorkspaceId(); break;
				case BrowserViewStorageScope.Ephemeral: identity = 'ephemeral:' + id; break;
				case BrowserViewStorageScope.Agent: identity = JSON.stringify(['agent', this.options.window.id, storage.affinity]); break;
			}
			const contextId = createHash('sha256').update(identity).digest('hex');
			const persistent = storage.scope === BrowserViewStorageScope.Global || storage.scope === BrowserViewStorageScope.Workspace;
			const electronSession = this.options.createSession((persistent ? 'persist:' : '') + 'ash-browser-' + contextId);
			const session = BrowserSession.getOrCreate(contextId, storage.scope, electronSession);
			view = this.instantiationService.createInstance(BrowserView, {
				id, window: this.options.window, view: this.options.createView(electronSession), navigation, creation: options, session,
				emitEvent: (event: BrowserViewEvent) => {
					if (event.type === 'closed') this.targets.deleteAndLeak(id);
					if (!this.isDisposed) this.events.fire(event);
				},
			});
		} catch (error) { navigation.release(); throw error; }
		this.targets.set(id, view);
		try { view.initialize(); return view; }
		catch (error) { this.targets.deleteAndDispose(id); throw error; }
	}
	async getState(id: string) { return this.target(id).getState(); }
	async layout(id: string, bounds: IBrowserViewBounds) { this.target(id).layout(bounds); }
	async setVisible(id: string, visible: boolean) { this.target(id).setVisible(visible); }
	loadURL(id: string, url: string, signal?: AbortSignal) { return this.target(id).loadURL(url, signal); }
	goBack(id: string) { return this.target(id).goBack(); }
	goForward(id: string) { return this.target(id).goForward(); }
	reload(id: string) { return this.target(id).reload(); }
	async stop(id: string) { this.target(id).stop(); }
	async focus(id: string) { this.target(id).focus(); }
	async destroyBrowserView(id: string) { this.target(id); this.targets.deleteAndDispose(id); }
}

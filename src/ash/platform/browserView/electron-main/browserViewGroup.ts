import { randomUUID } from 'node:crypto';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../base/common/async.js';
import type { IBrowserViewInfo } from '../common/browserView.js';
import type { IBrowserViewGroup, IBrowserViewGroupFilter } from '../common/browserViewGroup.js';
import type { CDPRequest, CDPTargetEvent, CDPTargetInfo } from '../common/cdp/types.js';
import { CDPBrowserProxy } from '../common/cdp/proxy.js';
import type { BrowserView } from './browserView.js';
import { IBrowserViewMainService } from './browserViewMainService.js';

/** A logical CDP browser references pages selected by Main; it never owns their lifetime. */
export class BrowserViewGroup extends Disposable implements IBrowserViewGroup {
	public readonly id = randomUUID();
	private readonly destroyed = this._register(new Emitter<void>());
	public readonly onDidDestroy = this.destroyed.event;
	private readonly targetEvents = this._register(new Emitter<CDPTargetEvent>());
	private readonly debugger: CDPBrowserProxy;
	public get onCDPMessage() { return this.debugger.onMessage; }
	private readonly pages = new Map<string, BrowserView>();
	private readonly targetIds = new Map<string, string>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly attachments = this._register(new DisposableMap<string, DisposableStore>());
	constructor(private readonly filter: IBrowserViewGroupFilter, private readonly retire: (id: string) => void, @IBrowserViewMainService private readonly views: IBrowserViewMainService) {
		super();
		this.debugger = this._register(new CDPBrowserProxy({
			targetInfo: { targetId: this.id, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false, browserContextId: this.id },
			onTargetEvent: this.targetEvents.event,
			whenReady: async () => { await Promise.all(this.pending.values()); },
			getTargets: () => [...this.pages.keys()].map(id => this.info(id)),
			getTargetInfo: id => this.info(id),
			getVersion: () => ({
				protocolVersion: '1.3', product: 'Chrome/' + process.versions.chrome, revision: '',
				userAgent: 'Chrome/' + process.versions.chrome, jsVersion: process.versions.v8,
			}),
			getWindowForTarget: id => {
				const page = this.page(id);
				const bounds = page.view.getBounds();
				return {
					windowId: page.getInfo().host.windowId,
					bounds: { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, windowState: 'normal' },
				};
			},
			getBrowserContexts: () => [...new Set([...this.pages.values()].map(page => page.session.id))],
			createTarget: async (url, contextId) => {
				if (this.filter.browserIds) { throw new Error('BrowserGroupHasFixedTargets'); }
				if (contextId !== undefined && ![...this.pages.values()].some(page => page.session.id === contextId)) { throw new Error('BrowserContextAccessDenied'); }
				const page = await this.views.createTarget(url, this.filter.sandboxSessionId, new AbortController().signal);
				await this.accept(page.getInfo());
				return this.info(page.id);
			},
			activateTarget: id => this.page(id).focus(),
			closeTarget: id => this.views.destroyBrowserView(this.page(id).id),
			sendCommand: (id, method, params, sessionId) => {
				const page = this.page(id);
				return raceCancellationError(
					page.debugger.sendCommand(method, params, sessionId),
					this.views.agentAccessSignal(page.id, this.filter.sandboxSessionId),
					'BrowserSharingRevoked',
				);
			},
		}));
		this._register(views.onDidEvent(event => {
			if (event.type === 'created') { void this.accept(event.info).catch(() => this.dispose()); }
			else if (event.type === 'closed') { this.remove(event.targetId); }
			else if (event.type === 'sharingChanged') {
				if (!event.threadIds.includes(this.filter.sandboxSessionId)) { this.remove(event.targetId); }
				else { const page = this.views.tryGetBrowserView(event.targetId); if (page) { void this.accept(page.getInfo()).catch(() => this.dispose()); } }
			}
			else if (event.type === 'stateChanged' && this.pages.has(event.state.targetId)) {
				this.targetEvents.fire({ type: 'changed', targetInfo: this.info(event.state.targetId) });
			}
		}));
	}
	public async initialize(): Promise<void> {
		await Promise.all((await this.views.getBrowserViews()).map(info => this.accept(info)));
		this.assertNotDisposed();
	}
	private accept(info: IBrowserViewInfo): Promise<void> {
		if ((this.filter.browserIds && !this.filter.browserIds.includes(info.id)) || this.pages.has(info.id)) { return Promise.resolve(); }
		try { this.views.validateAgentAccess(info.id, this.filter.sandboxSessionId); } catch { return Promise.resolve(); }
		const existing = this.pending.get(info.id);
		if (existing) { return existing.then(() => this.accept(info)); }
		const page = this.views.tryGetBrowserView(info.id);
		if (!page) { return Promise.resolve(); }
		const resources = new DisposableStore();
		resources.add(page.debugger.acquire());
		resources.add(page.debugger.onEvent(message => {
			const targetId = this.targetIds.get(page.id);
			if (targetId) { this.targetEvents.fire({ type: 'message', targetId, message }); }
		}));
		this.attachments.set(page.id, resources);
		const pending = page.debugger.getTargetId().then(targetId => {
			if (this.isDisposed || page.signal.aborted || this.attachments.get(page.id) !== resources) { return; }
			try { this.views.validateAgentAccess(page.id, this.filter.sandboxSessionId); } catch { this.attachments.deleteAndDispose(page.id); return; }
			// CDP target identity must remain Chromium's identity: its root frame uses that same ID.
			this.targetIds.set(page.id, targetId);
			this.pages.set(page.id, page);
			this.targetEvents.fire({ type: 'created', targetInfo: this.info(page.id) });
		}).catch(error => {
			this.attachments.deleteAndDispose(page.id);
			if (!page.signal.aborted && !this.isDisposed) { throw error; }
		}).finally(() => this.pending.delete(page.id));
		this.pending.set(page.id, pending);
		return pending;
	}
	private remove(id: string): void {
		const known = this.pages.delete(id);
		const targetId = this.targetIds.get(id);
		if (known && targetId) { this.targetEvents.fire({ type: 'destroyed', targetId }); }
		this.attachments.deleteAndDispose(id);
		this.targetIds.delete(id);
	}
	private page(id: unknown): BrowserView {
		if (typeof id !== 'string') { throw new Error('BrowserTargetAccessDenied'); }
		const viewId = this.pages.has(id) ? id : [...this.targetIds].find(([, targetId]) => targetId === id)?.[0];
		if (!viewId || !this.pages.has(viewId)) { throw new Error('BrowserTargetAccessDenied'); }
		return this.views.validateAgentAccess(viewId, this.filter.sandboxSessionId);
	}
	private info(id: string): CDPTargetInfo {
		const page = this.page(id);
		const state = page.getState();
		return { targetId: this.targetIds.get(page.id)!, browserViewId: page.id, type: 'page', title: state.title, url: state.url, attached: false, canAccessOpener: false, browserContextId: page.session.id };
	}
	public sendCDPMessage(message: CDPRequest): Promise<void> {
		this.assertNotDisposed();
		return this.debugger.sendMessage(message);
	}
	protected override disposeCore(): void {
		this.retire(this.id);
		this.destroyed.fire();
		this.debugger.dispose();
		this.pages.clear();
		this.targetIds.clear();
		super.disposeCore();
	}
}

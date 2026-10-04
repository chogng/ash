import { randomUUID } from 'node:crypto';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { BrowserViewStorageScope, type IBrowserViewInfo } from '../common/browserView.js';
import type { IBrowserViewGroup, IBrowserViewGroupFilter } from '../common/browserViewGroup.js';
import type { CDPEvent, CDPRequest, CDPResponse, CDPTargetInfo } from '../common/cdp/types.js';
import type { BrowserView } from './browserView.js';
import { IBrowserViewMainService } from './browserViewMainService.js';

type Session = { type: 'browser' } | { type: 'page'; viewId: string; parent?: string; actual?: string; autoAttach: boolean; automatic?: boolean };

/** A logical CDP browser references pages selected by Main; it never owns their lifetime. */
export class BrowserViewGroup extends Disposable implements IBrowserViewGroup {
	public readonly id = randomUUID();
	private readonly destroyed = this._register(new Emitter<void>());
	public readonly onDidDestroy = this.destroyed.event;
	private readonly messages = this._register(new Emitter<CDPEvent | CDPResponse>());
	public readonly onCDPMessage = this.messages.event;
	private readonly pages = new Map<string, BrowserView>();
	private readonly targetIds = new Map<string, string>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly attachments = this._register(new DisposableMap<string, DisposableStore>());
	private readonly sessions = new Map<string, Session>();
	private readonly discover = new Set<string | undefined>();
	private readonly autoAttach = new Set<string | undefined>();
	constructor(private readonly filter: IBrowserViewGroupFilter, private readonly retire: (id: string) => void, @IBrowserViewMainService private readonly views: IBrowserViewMainService) {
		super();
		this._register(views.onDidEvent(event => {
			if (event.type === 'created') { void this.accept(event.info).catch(() => this.dispose()); }
			else if (event.type === 'closed') { this.remove(event.targetId); }
			else if (event.type === 'stateChanged' && this.pages.has(event.state.targetId)) {
				for (const parent of this.discover) { this.event('Target.targetInfoChanged', { targetInfo: this.info(event.state.targetId) }, parent); }
			}
		}));
	}
	public async initialize(): Promise<void> {
		await Promise.all((await this.views.getBrowserViews()).map(info => this.accept(info)));
		this.assertNotDisposed();
	}
	private accept(info: IBrowserViewInfo): Promise<void> {
		if (info.owner.type !== 'agent' || info.owner.sessionId !== this.filter.sandboxSessionId
			|| info.session.scope !== BrowserViewStorageScope.Agent || info.session.affinity !== this.filter.sandboxSessionId
			|| (this.filter.browserIds && !this.filter.browserIds.includes(info.id)) || this.pages.has(info.id)) { return Promise.resolve(); }
		const existing = this.pending.get(info.id);
		if (existing) { return existing; }
		const page = this.views.tryGetBrowserView(info.id);
		if (!page) { return Promise.resolve(); }
		const resources = new DisposableStore();
		resources.add(page.debugger.acquire());
		resources.add(page.debugger.onEvent(event => this.forward(page.id, event)));
		this.attachments.set(page.id, resources);
		const pending = page.debugger.getTargetId().then(targetId => {
			if (this.isDisposed || page.signal.aborted) { this.attachments.deleteAndDispose(page.id); return; }
			// CDP target identity must remain Chromium's identity: its root frame uses that same ID.
			this.targetIds.set(page.id, targetId);
			this.pages.set(page.id, page);
			for (const parent of this.discover) { this.event('Target.targetCreated', { targetInfo: this.info(page.id) }, parent); }
			for (const parent of this.autoAttach) { this.attach(page.id, parent, true); }
		}).catch(error => {
			this.attachments.deleteAndDispose(page.id);
			if (!page.signal.aborted && !this.isDisposed) { throw error; }
		}).finally(() => this.pending.delete(page.id));
		this.pending.set(page.id, pending);
		return pending;
	}
	private remove(id: string): void {
		const known = this.pages.delete(id);
		for (const [sessionId, session] of [...this.sessions]) {
			if (session.type === 'page' && session.viewId === id && this.sessions.has(sessionId)) { this.detach(sessionId); }
		}
		this.attachments.deleteAndDispose(id);
		if (known) { for (const parent of this.discover) { this.event('Target.targetDestroyed', { targetId: this.targetIds.get(id) }, parent); } }
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
		return { targetId: this.targetIds.get(page.id)!, browserViewId: page.id, type: 'page', title: state.title, url: state.url, attached: [...this.sessions.values()].some(session => session.type === 'page' && session.viewId === page.id), canAccessOpener: false, browserContextId: page.session.id };
	}
	private attach(id: unknown, parent?: string, automatic = false): string {
		const page = this.page(id);
		if (!this.attachments.has(page.id)) {
			const resources = new DisposableStore();
			resources.add(page.debugger.acquire());
			resources.add(page.debugger.onEvent(event => this.forward(page.id, event)));
			this.attachments.set(page.id, resources);
		}
		const sessionId = randomUUID();
		this.sessions.set(sessionId, { type: 'page', viewId: page.id, parent, autoAttach: false, automatic });
		this.event('Target.attachedToTarget', { sessionId, targetInfo: this.info(page.id), waitingForDebugger: false }, parent);
		return sessionId;
	}
	private detach(id: string): void {
		const session = this.sessions.get(id);
		if (!session) { throw new Error('BrowserCDPSessionUnavailable'); }
		this.sessions.delete(id);
		this.discover.delete(id);
		this.autoAttach.delete(id);
		if (session.type === 'page') {
			for (const [childId, child] of [...this.sessions]) {
				if (child.type === 'page' && child.parent === id) { this.detach(childId); }
			}
			this.event('Target.detachedFromTarget', { sessionId: id, targetId: this.targetIds.get(session.viewId) }, session.parent);
		} else {
			for (const [childId, child] of [...this.sessions]) {
				if (child.type === 'page' && child.parent === id) { this.detach(childId); }
			}
		}
	}
	private event(method: string, params: unknown, sessionId?: string): void {
		if (!this.isDisposed) { this.messages.fire({ method, params, ...(sessionId ? { sessionId } : {}) }); }
	}
	private forward(viewId: string, event: CDPEvent): void {
		for (const [id, session] of [...this.sessions]) {
			if (session.type !== 'page' || session.viewId !== viewId || session.actual !== event.sessionId) { continue; }
			if (event.method === 'Target.attachedToTarget' && isRecord(event.params)) {
				if (!session.autoAttach || typeof event.params.sessionId !== 'string') { continue; }
				const childId = randomUUID();
				this.sessions.set(childId, { type: 'page', viewId, parent: id, actual: event.params.sessionId, autoAttach: false });
				this.event(event.method, { ...event.params, sessionId: childId }, id);
			} else if (event.method === 'Target.detachedFromTarget' && isRecord(event.params)) {
				for (const [childId, child] of [...this.sessions]) {
					if (child.type === 'page' && child.parent === id && child.actual === event.params.sessionId) { this.detach(childId); }
				}
			} else { this.event(event.method, event.params, id); }
		}
	}
	public async sendCDPMessage(message: CDPRequest): Promise<void> {
		this.assertNotDisposed();
		try {
			await Promise.all(this.pending.values());
			const result = await this.command(message);
			this.messages.fire({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
		} catch (error) {
			this.messages.fire({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
		}
	}
	private async command(message: CDPRequest): Promise<unknown> {
		const params = message.params === undefined ? {} : message.params;
		if (!isRecord(params)) { throw new TypeError('Invalid CDP parameters'); }
		const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined;
		if (message.sessionId && !session) { throw new Error('BrowserCDPSessionUnavailable'); }
		const browser = !session || session.type === 'browser';
		if (message.method === 'Browser.getVersion') {
			return { protocolVersion: '1.3', product: 'Chrome/' + process.versions.chrome, revision: '', userAgent: 'Chrome/' + process.versions.chrome, jsVersion: process.versions.v8 };
		}
		if (message.method === 'Target.getTargetInfo') {
			const id = params.targetId ?? (session?.type === 'page' ? session.viewId : undefined);
			return { targetInfo: id === undefined ? { targetId: this.id, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false, browserContextId: this.id } : this.info(this.page(id).id) };
		}
		if (message.method === 'Browser.getWindowForTarget') {
			const page = this.page(params.targetId ?? (session?.type === 'page' ? session.viewId : undefined));
			const bounds = page.view.getBounds();
			return { windowId: page.getInfo().host.windowId, bounds: { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, windowState: 'normal' } };
		}
		if (browser || (message.method.startsWith('Target.') && message.method !== 'Target.setAutoAttach')) {
			switch (message.method) {
				case 'Target.getTargets': return { targetInfos: [...this.pages.keys()].map(id => this.info(id)) };
				case 'Target.getBrowserContexts': return { browserContextIds: [...new Set([...this.pages.values()].map(page => page.session.id))] };
				case 'Target.setDiscoverTargets':
					if (params.discover === true) {
						this.discover.add(message.sessionId);
						for (const id of this.pages.keys()) { this.event('Target.targetCreated', { targetInfo: this.info(id) }, message.sessionId); }
					} else { this.discover.delete(message.sessionId); }
					return {};
				case 'Target.setAutoAttach':
					if (params.flatten !== true) { throw new Error('CDP requires flattened sessions'); }
					if (params.autoAttach === true) {
						this.autoAttach.add(message.sessionId);
						for (const id of this.pages.keys()) {
							if (![...this.sessions.values()].some(value => value.type === 'page' && value.viewId === id && value.parent === message.sessionId && value.automatic)) { this.attach(id, message.sessionId, true); }
						}
					} else {
						this.autoAttach.delete(message.sessionId);
						for (const [id, value] of [...this.sessions]) {
							if (value.type === 'page' && value.parent === message.sessionId && value.automatic && this.sessions.has(id)) { this.detach(id); }
						}
					}
					return {};
				case 'Target.attachToBrowserTarget': {
					const sessionId = randomUUID(); this.sessions.set(sessionId, { type: 'browser' }); return { sessionId };
				}
				case 'Target.attachToTarget':
					if (params.flatten !== true) { throw new Error('CDP requires flattened sessions'); }
					return { sessionId: this.attach(params.targetId, message.sessionId) };
				case 'Target.detachFromTarget':
					if (typeof params.sessionId !== 'string') { throw new TypeError('Invalid CDP session'); }
					this.detach(params.sessionId); return {};
				case 'Target.closeTarget': await this.views.destroyBrowserView(this.page(params.targetId).id); return { success: true };
				case 'Target.activateTarget': this.page(params.targetId).focus(); return {};
				case 'Target.createTarget': {
					if (this.filter.browserIds) { throw new Error('BrowserGroupHasFixedTargets'); }
					if (params.browserContextId !== undefined && ![...this.pages.values()].some(page => page.session.id === params.browserContextId)) { throw new Error('BrowserContextAccessDenied'); }
					if (typeof params.url !== 'string') { throw new TypeError('Invalid target URL'); }
					const page = await this.views.createTarget(params.url, this.filter.sandboxSessionId, new AbortController().signal);
					await this.accept(page.getInfo());
					return { targetId: this.targetIds.get(page.id)! };
				}
				default: throw new Error('Unsupported browser CDP command: ' + message.method);
			}
		}
		if (session.type !== 'page' || message.method.startsWith('Browser.')) { throw new Error('BrowserCDPAccessDenied'); }
		const page = this.page(session.viewId);
		if (message.method === 'Target.setAutoAttach') { session.autoAttach = params.autoAttach === true; }
		// Session-scoped Target commands belong to the selected page, including its child frames.
		return page.debugger.sendCommand(message.method, params, session.actual);
	}
	protected override disposeCore(): void {
		this.retire(this.id);
		this.destroyed.fire();
		this.pages.clear(); this.sessions.clear(); this.targetIds.clear();
		this.discover.clear(); this.autoAttach.clear();
		super.disposeCore();
	}
}

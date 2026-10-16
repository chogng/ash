import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { raceCancellationError } from '../../../base/common/async.js';
import type { IBrowserViewInfo } from '../common/browserView.js';
import type { IBrowserViewGroup, IBrowserViewGroupFilter } from '../common/browserViewGroup.js';
import type { CDPRequest, CDPTargetEvent, CDPTargetInfo } from '../common/cdp/types.js';
import { CDPBrowserProxy } from '../common/cdp/proxy.js';
import type { BrowserView } from './browserView.js';
import { IBrowserViewMainService } from './browserViewMainService.js';

interface CommandAuthority { readonly signal: AbortSignal; readonly networkToken: string | null; }

/** A logical CDP browser borrows Main's pages and owns its protocol sessions and newly created contexts. */
export class BrowserViewGroup extends Disposable implements IBrowserViewGroup {
	public readonly id = randomUUID();
	private readonly destroyed = this._register(new Emitter<void>());
	public readonly onDidDestroy = this.destroyed.event;
	private readonly targetEvents = this._register(new Emitter<CDPTargetEvent>());
	private readonly debugger: CDPBrowserProxy;
	public get onCDPMessage() { return this.debugger.onMessage; }
	private readonly pages = new Map<string, BrowserView>();
	private readonly targetIds = new Map<string, string>();
	private readonly rootSessions = new Map<string, string>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly attachments = this._register(new DisposableMap<string, DisposableStore>());
	private readonly contexts = new Set<string>();
	private readonly authority = new AsyncLocalStorage<CommandAuthority>();
	private readonly detachments = new Set<Promise<unknown>>();
	private readonly cancellation = new AbortController();
	private contextCleanup: Promise<void> = Promise.resolve();
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
			getBrowserContexts: () => [...new Set([...this.contexts, ...[...this.pages.values()].map(page => page.session.id)])],
			createBrowserContext: () => {
				if (this.filter.browserIds) { throw new Error('BrowserGroupHasFixedTargets'); }
				const id = this.views.createBrowserContext(this.filter.sandboxSessionId);
				this.contexts.add(id);
				return id;
			},
			disposeBrowserContext: async id => {
				if (!this.contexts.delete(id)) { throw new Error('BrowserContextAccessDenied'); }
				await this.views.disposeBrowserContext(id, this.filter.sandboxSessionId);
			},
			createTarget: async (url, contextId) => {
				if (this.filter.browserIds) { throw new Error('BrowserGroupHasFixedTargets'); }
				if (contextId !== undefined && !this.contexts.has(contextId)
					&& ![...this.pages.values()].some(page => page.session.id === contextId && page.getInfo().owner.type === 'agent')) { throw new Error('BrowserContextAccessDenied'); }
				const authority = this.authority.getStore();
				const signal = AbortSignal.any([this.cancellation.signal, ...(authority ? [authority.signal] : [])]);
				const page = await this.views.createTarget('about:blank', this.filter.sandboxSessionId, signal, contextId);
				try {
					await page.waitForLoad(signal);
					await page.loadURL(url, signal, authority?.networkToken ?? null);
					await this.accept(page.getInfo());
					return this.info(page.id);
				} catch (error) { page.dispose(); throw error; }
			},
			activateTarget: id => this.page(id).focus(),
			closeTarget: id => this.views.destroyBrowserView(this.page(id).id),
			sendCommand: (id, method, params, sessionId) => {
				const page = this.page(id);
				const authority = this.authority.getStore();
				// Replies and debugger controls must pass an operation that is waiting for them.
				const unblocks = ['Page.handleJavaScriptDialog', 'Debugger.resume', 'Debugger.stepInto', 'Debugger.stepOut', 'Debugger.stepOver', 'Runtime.terminateExecution', 'Fetch.continueRequest', 'Fetch.continueResponse', 'Fetch.fulfillRequest', 'Fetch.failRequest'].includes(method);
				const send = async () => {
					const result = await page.debugger.sendCommand(method, params, sessionId ?? this.rootSessions.get(page.id));
					if (authority && method === 'Page.navigate') { await page.waitForLoad(authority.signal); }
					return result;
				};
				return raceCancellationError(
					authority && !unblocks ? page.runOperation(authority.signal, send, authority.networkToken) : send(),
					AbortSignal.any([this.cancellation.signal, this.views.agentAccessSignal(page.id, this.filter.sandboxSessionId)]),
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
		if (this.filter.agentOnly && info.owner.type !== 'agent') { return Promise.resolve(); }
		if ((this.filter.browserIds && !this.filter.browserIds.includes(info.id)) || this.pages.has(info.id)) { return Promise.resolve(); }
		try { this.views.validateAgentAccess(info.id, this.filter.sandboxSessionId); } catch { return Promise.resolve(); }
		const existing = this.pending.get(info.id);
		if (existing) { return existing.then(() => this.accept(info)); }
		const page = this.views.tryGetBrowserView(info.id);
		if (!page) { return Promise.resolve(); }
		const resources = new DisposableStore();
		let rootSession: string | undefined;
		resources.add(toDisposable(() => {
			if (rootSession && !page.signal.aborted) {
				// Each logical browser owns a real Chromium session, so releasing CDP cannot
				// leave its enabled domains or paused debugger attached to Playwright's session.
				const detachment = page.debugger.sendCommand('Target.detachFromTarget', { sessionId: rootSession }).catch(() => { });
				this.detachments.add(detachment);
				void detachment.finally(() => this.detachments.delete(detachment));
			}
		}));
		resources.add(page.debugger.onDidDetach(() => this.dispose()));
		resources.add(page.debugger.acquire());
		resources.add(page.debugger.onEvent(message => {
			const targetId = this.targetIds.get(page.id);
			if (targetId && message.sessionId) {
				this.targetEvents.fire({ type: 'message', targetId, message: message.sessionId === rootSession ? { method: message.method, params: message.params } : message });
			}
		}));
		this.attachments.set(page.id, resources);
		const pending = page.debugger.getTargetId().then(async targetId => {
			if (this.isDisposed || page.signal.aborted) { return; }
			const attachment = await page.debugger.sendCommand('Target.attachToTarget', { targetId, flatten: true });
			if (!isRecord(attachment) || typeof attachment.sessionId !== 'string') { throw new Error('BrowserCDPAttachmentFailed'); }
			rootSession = attachment.sessionId;
			if (this.isDisposed || page.signal.aborted || this.attachments.get(page.id) !== resources) {
				if (!page.signal.aborted) { await page.debugger.sendCommand('Target.detachFromTarget', { sessionId: rootSession }).catch(() => { }); }
				return;
			}
			try { this.views.validateAgentAccess(page.id, this.filter.sandboxSessionId); } catch { this.attachments.deleteAndDispose(page.id); return; }
			// CDP target identity must remain Chromium's identity: its root frame uses that same ID.
			this.targetIds.set(page.id, targetId);
			this.rootSessions.set(page.id, rootSession);
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
		this.rootSessions.delete(id);
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
	public sendCDPMessage(message: CDPRequest, authority?: CommandAuthority): Promise<void> {
		this.assertNotDisposed();
		return authority ? this.authority.run(authority, () => this.debugger.sendMessage(message)) : this.debugger.sendMessage(message);
	}
	public async close(): Promise<void> {
		this.dispose();
		await Promise.all([this.contextCleanup, ...this.detachments]);
	}
	protected override disposeCore(): void {
		this.cancellation.abort(new Error('BrowserCDPConnectionClosed'));
		this.retire(this.id);
		this.destroyed.fire();
		this.debugger.dispose();
		this.pages.clear();
		this.targetIds.clear();
		this.rootSessions.clear();
		this.contextCleanup = Promise.all([...this.contexts].map(id => this.views.disposeBrowserContext(id, this.filter.sandboxSessionId))).then(() => { });
		void this.contextCleanup.catch(error => console.error('Could not release CDP browser contexts', error));
		this.contexts.clear();
		super.disposeCore();
	}
}

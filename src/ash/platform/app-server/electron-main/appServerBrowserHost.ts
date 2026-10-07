import { decodeAppServerServerRequestParams } from '../common/generated/AppServerProtocolDecoder.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { BrowserCreateParams, BrowserObserveParams, BrowserPerformParams, BrowserCloseParams } from '../common/generated/index.js';
import { IBrowserViewMainService } from '../../browserView/electron-main/browserViewMainService.js';
import type { BrowserView } from '../../browserView/electron-main/browserView.js';
import { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';

/** Owns cancellable browser operations requested by one renderer. */
export class AppServerBrowserHost extends Disposable {
	private readonly operations = new Map<string, AbortController>();
	private cancellation = new AbortController();
	private readonly sessions = new Set<string>();
	constructor(@IBrowserViewMainService private readonly views: IBrowserViewMainService,
		@IPlaywrightService private readonly playwright: IPlaywrightService) {
		super();
		this._register(toDisposable(() => { for (const controller of this.operations.values()) { controller.abort(); } this.operations.clear(); }));
		this._register(views.onDidEvent(event => {
			if (event.type === 'created' && event.info.owner.type === 'agent') {
				this.hostedTargets.set(event.info.id, event.info.owner.sessionId);
			} else if (event.type === 'closed') {
				const sessionId = this.hostedTargets.get(event.targetId);
				this.hostedTargets.delete(event.targetId);
				if (sessionId && this.sessions.has(sessionId) && ![...this.hostedTargets.values()].includes(sessionId)) {
					this.sessions.delete(sessionId);
					void this.playwright.disposeSession(sessionId).catch(() => { });
				}
			}
		}));
	}

	private readonly hostedTargets = new Map<string, string>();
	async create(params: BrowserCreateParams, context: { signal: AbortSignal; }) {
		this.assertNotDisposed();
		const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
		const view = await this.views.createTarget(params.url, params.threadId, signal);
		if (signal.aborted) {
			view.dispose();
			signal.throwIfAborted();
		}
		return { targetId: view.id };
	}
	observe(params: BrowserObserveParams, context: { signal: AbortSignal; }) {
		const { view, signal } = this.target(params.targetId, params.threadId, context.signal);
		return this.automate(view, params.threadId, signal, async id => {
			const observation = await this.playwright.getObservation(id, params.threadId, view.id, params);
			const state = view.getState();
			// Main owns the visible URL and authoritative load state; the worker only observes Chromium.
			return { ...observation, url: state.url, title: state.title, loading: state.loading };
		});
	}
	async perform(params: BrowserPerformParams, context: { signal: AbortSignal; }) {
		const { view, signal } = this.target(params.action.targetId, params.threadId, context.signal);
		if (params.action.type === 'navigate') { await view.loadURL(params.action.url, signal); }
		else { await this.automate(view, params.threadId, signal, id => this.playwright.performAction(id, params.threadId, view.id, params.action)); }
		return { targetId: view.id };
	}
	private automate<T>(view: BrowserView, sessionId: string, signal: AbortSignal, execute: (id: string) => Promise<T>): Promise<T> {
		return view.runOperation(signal, async operationSignal => {
			await view.waitForLoad(operationSignal);
			const id = randomUUID();
			this.sessions.add(sessionId);
			using cancellation = addAbortListener(operationSignal, () => {
				void this.playwright.cancelOperation(id).catch(() => { });
			});
			operationSignal.throwIfAborted();
			const result = await execute(id);
			operationSignal.throwIfAborted();
			await view.waitForLoad(operationSignal);
			return result;
		});
	}
	async close(params: BrowserCloseParams): Promise<null> {
		this.views.validateAgentAccess(params.targetId, params.threadId);
		try { await this.views.destroyBrowserView(params.targetId); return null; }
		finally { this.hostedTargets.delete(params.targetId); }
	}
	private target(id: string, sessionId: string, requestSignal: AbortSignal): { view: BrowserView; signal: AbortSignal; } {
		this.assertNotDisposed();
		const view = this.views.validateAgentAccess(id, sessionId);
		return { view, signal: AbortSignal.any([requestSignal, this.cancellation.signal, this.views.agentAccessSignal(id, sessionId)]) };
	}
	/** Retiring a connection closes its pages without disturbing pages opened by the user. */
	reset(): void {
		this.views.cancelPermissionRequests();
		this.views.revokeSharing();
		this.cancellation.abort(new Error('BrowserCapabilityUnavailable'));
		this.cancellation = new AbortController();
		for (const id of this.hostedTargets.keys()) this.views.tryGetBrowserView(id)?.dispose();
		this.hostedTargets.clear();
		for (const sessionId of this.sessions) { void this.playwright.disposeSession(sessionId).catch(() => { }); }
		this.sessions.clear();
	}
	protected override disposeCore(): void { this.reset(); super.disposeCore(); }

	public routes(): readonly IpcRoute<unknown, unknown>[] {
		const operation = (value: unknown): { id: string; params: unknown; } => {
			if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) { throw new Error('Invalid browser operation'); }
			return { id: value.id, params: value.params };
		};
		const run = async (value: unknown, execute: (params: unknown, context: { signal: AbortSignal; }) => unknown | Promise<unknown>): Promise<unknown> => {
			this.assertNotDisposed();
			const request = operation(value);
			if (this.operations.has(request.id) || this.operations.size >= 128) { throw new Error('Browser operation capacity exceeded'); }
			const controller = new AbortController();
			this.operations.set(request.id, controller);
			const timer = setTimeout(() => controller.abort(), 30_000);
			try { return await raceCancellationError(Promise.resolve(execute(request.params, { signal: controller.signal })), controller.signal, 'BrowserRequestCancelled'); }
			finally { clearTimeout(timer); this.operations.delete(request.id); }
		};
		return [
			{
				channel: 'ash:browser-host:sharing', validate: operation, invoke: value => run(value, async params => {
					const sharing = decodeAppServerServerRequestParams('browser/sharing/set', params);
					// Revoking a closed page still acknowledges release of the backend's grant record.
					if (sharing.threadIds.length || this.views.tryGetBrowserView(sharing.targetId)) await this.views.setSharing(sharing.targetId, sharing.threadIds);
					return null;
				})
			},
			{ channel: 'ash:browser-host:create', validate: operation, invoke: value => run(value, (params, context) => this.create(decodeAppServerServerRequestParams('browser/create', params), context)) },
			{ channel: 'ash:browser-host:observe', validate: operation, invoke: value => run(value, (params, context) => this.observe(decodeAppServerServerRequestParams('browser/observe', params), context)) },
			{ channel: 'ash:browser-host:perform', validate: operation, invoke: value => run(value, (params, context) => this.perform(decodeAppServerServerRequestParams('browser/perform', params), context)) },
			{ channel: 'ash:browser-host:close', validate: operation, invoke: value => run(value, params => this.close(decodeAppServerServerRequestParams('browser/close', params))) },
			{ channel: 'ash:browser-host:cancel', validate: operation, invoke: value => { this.operations.get(operation(value).id)?.abort(); } },
		];
	}
}

import type { decodeAppServerServerRequestParams } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { BrowserCreateParams, BrowserObserveParams, BrowserPerformParams, BrowserPerformResult, BrowserCloseParams, BrowserListParams } from '../../../../../.build/protocol/typescript/index.js';
import { IBrowserViewMainService } from '../../browserView/electron-main/browserViewMainService.js';
import type { BrowserView } from '../../browserView/electron-main/browserView.js';
import { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { Event } from '../../../base/common/event.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { BrowserViewCDPService } from '../../browserView/electron-main/browserViewCDPService.js';

/** Owns cancellable browser operations requested by one renderer. */
export class AppServerBrowserHost extends Disposable {
	private readonly operations = new Map<string, AbortController>();
	private cancellation = new AbortController();
	private readonly sessions = new Set<string>();
	private readonly canvasOperations = new Map<string, Promise<unknown>>();
	private enabled = true;
	private cdpEnabled = false;
	private readonly cdp: BrowserViewCDPService;
	constructor(
		@IBrowserViewMainService private readonly views: IBrowserViewMainService,
		@IPlaywrightService private readonly playwright: IPlaywrightService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.cdp = this._register(instantiation.createInstance(BrowserViewCDPService));
		this._register(
			toDisposable(() => {
				for (const controller of this.operations.values()) {
					controller.abort();
				}
				this.operations.clear();
			}),
		);
		this._register(
			views.onDidEvent(event => {
				if (event.type === 'created' && event.info.owner.type === 'agent') {
					this.hostedTargets.set(event.info.id, event.info.owner.sessionId);
				} else if (event.type === 'closed') {
					const sessionId = this.hostedTargets.get(event.targetId);
					this.hostedTargets.delete(event.targetId);
					if (sessionId && this.sessions.has(sessionId) && ![...this.hostedTargets.values()].includes(sessionId)) {
						this.sessions.delete(sessionId);
						void this.playwright.disposeSession(sessionId).catch(() => {});
						void this.cdp.disposeSession(sessionId).catch(() => {});
					}
				}
			}),
		);
	}

	private readonly hostedTargets = new Map<string, string>();
	public async configure(preference: { readonly enabled: boolean; readonly cdpEnabled: boolean }): Promise<void> {
		this.assertNotDisposed();
		this.enabled = preference.enabled;
		this.cdpEnabled = preference.enabled && preference.cdpEnabled;
		const released = this.cdpEnabled ? Promise.resolve() : this.cdp.reset();
		if (!this.enabled) {
			this.reset();
		}
		await released;
	}
	private assertEnabled(): void {
		this.assertNotDisposed();
		if (!this.enabled) {
			throw new Error('BrowserCapabilityUnavailable');
		}
	}
	async list(params: BrowserListParams) {
		this.assertEnabled();
		const pages = [];
		for (const info of await this.views.getBrowserViews()) {
			try {
				this.views.validateAgentAccess(info.id, params.threadId);
			} catch (error) {
				if (error instanceof Error && /BrowserTarget(AccessDenied|Unavailable)/.test(error.message)) {
					continue;
				}
				throw error;
			}
			pages.push({
				targetId: info.id,
				url: info.state.url,
				title: info.state.title.slice(0, 8192),
				loading: info.state.loading,
			});
		}
		if (pages.length > 256) {
			throw new Error('Browser page list exceeds its limit');
		}
		return { pages };
	}
	async create(params: BrowserCreateParams, context: { signal: AbortSignal }) {
		this.assertEnabled();
		const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
		if (!params.canvas) {
			return this.createPage(params, signal);
		}
		const key = JSON.stringify([params.canvas.sessionId, params.threadId, params.canvas.instanceId]);
		const pending = this.canvasOperations.get(key) ?? Promise.resolve();
		const opening = pending.catch(() => undefined).then(() => this.createPage(params, signal));
		this.canvasOperations.set(key, opening);
		try {
			return await opening;
		} finally {
			if (this.canvasOperations.get(key) === opening) {
				this.canvasOperations.delete(key);
			}
		}
	}

	private async createPage(params: BrowserCreateParams, signal: AbortSignal): Promise<{ targetId: string }> {
		signal.throwIfAborted();
		const canvas = params.canvas && {
			sessionId: params.canvas.sessionId,
			instanceId: params.canvas.instanceId,
			title: params.canvas.title,
			...(params.canvas.definition ? { extensionId: params.canvas.definition.extensionId, canvasId: params.canvas.definition.canvasId } : {}),
		};
		const existing =
			params.canvas &&
			(await this.views.getBrowserViews()).find(
				info =>
					info.canvas?.instanceId === params.canvas!.instanceId &&
					info.canvas?.sessionId === params.canvas!.sessionId &&
					(info.owner.type === 'agent' ? info.owner.sessionId : info.canvas.threadId) === params.threadId,
			);
		if (existing && (existing.owner.type !== 'agent' || existing.canvas?.extensionId !== canvas?.extensionId || existing.canvas?.canvasId !== canvas?.canvasId)) {
			throw new Error('CanvasInstanceAlreadyOwned');
		}
		const retained = existing ? this.views.tryGetBrowserView(existing.id) : undefined;
		const view = retained ?? (await this.views.createTarget('about:blank', params.threadId, signal, undefined, canvas));
		if (signal.aborted) {
			if (!retained) {
				view.dispose();
			}
			signal.throwIfAborted();
		}
		try {
			await view.waitForLoad(signal);
			await view.loadURL(params.url, signal, params.networkToken ?? null);
			if (canvas) {
				view.canvasOpened(canvas);
			}
			return { targetId: view.id };
		} catch (error) {
			if (!retained) {
				view.dispose();
			}
			throw error;
		}
	}
	observe(params: BrowserObserveParams, context: { signal: AbortSignal }) {
		const { view, signal } = this.target(params.targetId, params.threadId, context.signal);
		return this.automate(
			view,
			params.threadId,
			signal,
			async id => {
				const observation = await this.playwright.getObservation(id, params.threadId, view.id, params);
				const state = view.getState();
				// Main owns the visible URL and authoritative load state; the worker only observes Chromium.
				return { ...observation, url: state.url, title: state.title, loading: state.loading };
			},
			view.getInfo().owner.type === 'agent' ? (params.networkToken ?? null) : undefined,
		);
	}
	async perform(params: BrowserPerformParams, context: { signal: AbortSignal }): Promise<BrowserPerformResult> {
		if (params.action.type === 'cdp') {
			this.assertEnabled();
			if (!this.cdpEnabled) {
				throw new Error('BrowserCDPDisabled');
			}
			const view = this.views.validateAgentAccess(params.action.targetId, params.threadId);
			if (view.getInfo().owner.type !== 'agent') {
				throw new Error('BrowserNetworkIsolationRequired');
			}
			this.sessions.add(params.threadId);
			const targets = (await this.views.getBrowserViews()).filter(info => info.owner.type === 'agent' && info.owner.sessionId === params.threadId);
			const result = await this.cdp.perform(
				params.threadId,
				view,
				params.action.operation,
				AbortSignal.any([context.signal, this.cancellation.signal]),
				params.networkToken ?? null,
				params.uploads ?? [],
			);
			const closedTargetIds = targets.filter(info => !this.views.tryGetBrowserView(info.id)).map(info => info.id);
			return { targetId: view.id, ...result, ...(closedTargetIds.length ? { closedTargetIds } : {}) };
		}
		const { view, signal } = this.target(params.action.targetId, params.threadId, context.signal);
		if (view.getInfo().owner.type !== 'agent') {
			throw new Error('BrowserNetworkIsolationRequired');
		}
		if (params.action.type === 'handleDialog') {
			// Dialog completion must not queue behind the operation interrupted by that dialog.
			const id = randomUUID();
			this.sessions.add(params.threadId);
			using cancellation = addAbortListener(signal, () => {
				void this.playwright.cancelOperation(id).catch(() => {});
			});
			signal.throwIfAborted();
			await this.playwright.performAction(id, params.threadId, view.id, params.action);
			signal.throwIfAborted();
			return { targetId: view.id };
		}
		let output: string | undefined;
		if (params.action.type === 'navigate') {
			await view.loadURL(params.action.url, signal, params.networkToken ?? null);
		} else {
			output = await this.automate(view, params.threadId, signal, id => this.playwright.performAction(id, params.threadId, view.id, params.action), params.networkToken ?? null);
		}
		return { targetId: view.id, ...(output === undefined ? {} : { output }) };
	}
	private automate<T>(view: BrowserView, sessionId: string, signal: AbortSignal, execute: (id: string) => Promise<T>, networkToken?: string | null): Promise<T> {
		return view.runOperation(
			signal,
			async operationSignal => {
				await view.waitForLoad(operationSignal);
				const id = randomUUID();
				this.sessions.add(sessionId);
				using cancellation = addAbortListener(operationSignal, () => {
					void this.playwright.cancelOperation(id).catch(() => {});
				});
				operationSignal.throwIfAborted();
				const result = await execute(id);
				operationSignal.throwIfAborted();
				await view.waitForLoad(operationSignal);
				return result;
			},
			networkToken,
		);
	}
	async close(params: BrowserCloseParams): Promise<null> {
		const view = this.views.validateAgentAccess(params.targetId, params.threadId);
		if (view.getInfo().owner.type !== 'agent') {
			throw new Error('BrowserNetworkIsolationRequired');
		}
		try {
			await this.views.destroyBrowserView(params.targetId);
			return null;
		} finally {
			this.hostedTargets.delete(params.targetId);
		}
	}
	private target(id: string, sessionId: string, requestSignal: AbortSignal): { view: BrowserView; signal: AbortSignal } {
		this.assertEnabled();
		const view = this.views.validateAgentAccess(id, sessionId);
		return {
			view,
			signal: AbortSignal.any([requestSignal, this.cancellation.signal, this.views.agentAccessSignal(id, sessionId)]),
		};
	}
	/** Retiring a connection closes its pages without disturbing pages opened by the user. */
	reset(): void {
		void this.cdp.reset().catch(error => console.error('Could not release CDP connections', error));
		this.views.cancelPermissionRequests();
		this.views.revokeSharing();
		this.cancellation.abort(new Error('BrowserCapabilityUnavailable'));
		this.cancellation = new AbortController();
		for (const id of this.hostedTargets.keys()) this.views.tryGetBrowserView(id)?.dispose();
		this.hostedTargets.clear();
		for (const sessionId of this.sessions) {
			void this.playwright.disposeSession(sessionId).catch(() => {});
		}
		this.sessions.clear();
	}
	protected override disposeCore(): void {
		this.reset();
		super.disposeCore();
	}

	/** The IPC server selects this host using the authenticated window context. */
	public getChannel(): IServerChannel<string> {
		const routes = new Map(this.routes().map(route => [route.channel, route]));
		return {
			call: async <T>(_context: string, command: string, arg: unknown): Promise<T> => {
				this.assertNotDisposed();
				const route = routes.get(command);
				if (!route) {
					throw new Error('Unknown browser host command: ' + command);
				}
				return (await route.invoke(route.validate(arg))) as T;
			},
			listen: <T>(_context: string, event: string) => {
				this.assertNotDisposed();
				if (event !== 'onDidEvent') {
					throw new Error('Unknown browser host event: ' + event);
				}
				return this.views.onDidEvent as Event<T>;
			},
		};
	}

	private routes(): readonly IpcRoute<unknown, unknown>[] {
		const operation = (value: unknown): { id: string; params: unknown } => {
			if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) {
				throw new Error('Invalid browser operation');
			}
			return { id: value.id, params: value.params };
		};
		const run = async (
			value: unknown,
			execute: (params: unknown, context: { signal: AbortSignal }, decode: typeof decodeAppServerServerRequestParams) => unknown | Promise<unknown>,
		): Promise<unknown> => {
			this.assertNotDisposed();
			const request = operation(value);
			if (this.operations.has(request.id) || this.operations.size >= 128) {
				throw new Error('Browser operation capacity exceeded');
			}
			const controller = new AbortController();
			const signal = AbortSignal.any([controller.signal, this.cancellation.signal]);
			this.operations.set(request.id, controller);
			const timer = setTimeout(() => controller.abort(), 30_000);
			try {
				// Most windows never run a browser tool. Keep its schema out of Main's
				// idle heap, but validate every request before touching browser state.
				const operation = async () => {
					const { decodeAppServerServerRequestParams: decode } = await import('../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js');
					signal.throwIfAborted();
					this.assertNotDisposed();
					return execute(request.params, { signal }, decode);
				};
				return await raceCancellationError(operation(), signal, 'BrowserRequestCancelled');
			} finally {
				clearTimeout(timer);
				this.operations.delete(request.id);
			}
		};
		return [
			{
				channel: 'configure',
				validate: value => {
					if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.enabled !== 'boolean' || typeof value.cdpEnabled !== 'boolean') {
						throw new TypeError('Invalid browser configuration');
					}
					return { enabled: value.enabled, cdpEnabled: value.cdpEnabled };
				},
				invoke: value => this.configure(value as { enabled: boolean; cdpEnabled: boolean }),
			},
			{
				channel: 'list',
				validate: operation,
				invoke: value => run(value, (params, _context, decode) => this.list(decode('browser/list', params))),
			},
			{
				channel: 'disposeSession',
				validate: value => {
					if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.threadId !== 'string' || !value.threadId || value.threadId.length > 512) {
						throw new TypeError('Invalid browser session');
					}
					return value.threadId;
				},
				invoke: async value => {
					this.assertNotDisposed();
					const sessionId = value as string;
					if (this.sessions.delete(sessionId)) {
						await Promise.all([this.playwright.disposeSession(sessionId), this.cdp.disposeSession(sessionId)]);
					}
				},
			},
			{
				channel: 'network',
				validate: value => {
					if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.targetId !== 'string' || typeof value.requestId !== 'string' || typeof value.allowed !== 'boolean') {
						throw new TypeError('Invalid browser network response');
					}
					return value;
				},
				invoke: value => {
					const response = value as { targetId: string; requestId: string; allowed: boolean };
					const view = this.views.tryGetBrowserView(response.targetId);
					view?.session.respondToNetworkRequest(view.webContents.id, response.requestId, response.allowed);
				},
			},
			{
				channel: 'sharing',
				validate: operation,
				invoke: value =>
					run(value, async (params, _context, decode) => {
						const sharing = decode('browser/sharing/set', params);
						if (sharing.threadIds.length) {
							this.assertEnabled();
						}
						// Revoking a closed page still acknowledges release of the backend's grant record.
						if (sharing.threadIds.length || this.views.tryGetBrowserView(sharing.targetId)) await this.views.setSharing(sharing.targetId, sharing.threadIds);
						return null;
					}),
			},
			{
				channel: 'create',
				validate: operation,
				invoke: value => run(value, (params, context, decode) => this.create(decode('browser/create', params), context)),
			},
			{
				channel: 'observe',
				validate: operation,
				invoke: value => run(value, (params, context, decode) => this.observe(decode('browser/observe', params), context)),
			},
			{
				channel: 'perform',
				validate: operation,
				invoke: value => run(value, (params, context, decode) => this.perform(decode('browser/perform', params), context)),
			},
			{
				channel: 'close',
				validate: operation,
				invoke: value => run(value, (params, _context, decode) => this.close(decode('browser/close', params))),
			},
			{
				channel: 'cancel',
				validate: operation,
				invoke: value => {
					this.operations.get(operation(value).id)?.abort();
				},
			},
		];
	}
}

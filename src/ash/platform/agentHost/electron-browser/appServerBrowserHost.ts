import { generateUuid } from '../../../base/common/uuid.js';
import { APP_SERVER_SERVER_REQUESTS, APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerRequestParams, decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../browser/appServerProtocolClient.js';
import type { BrowserViewEvent, IBrowserViewOwner, IBrowserViewNetwork } from '../../browserView/common/browserView.js';
import type { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { Event } from '../../../base/common/event.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import { BrowserCDPSettingId, BrowserChatToolsSettingId } from '../../browserView/common/browserView.js';
import { CanvasesEnabledSettingId, type IAgentCanvasHost, type IAgentBrowserHostScope } from '../common/agentService.js';
import { ChatAIDisabledSettingId } from '../../chat/common/chatSettings.js';

export function registerAppServerBrowserHost(client: AppServerProtocolClient, playwrightService: IPlaywrightService, mainProcessService: IMainProcessService, configuration: IConfigurationService, canvases?: IAgentCanvasHost, resolveNetwork?: (owner: IBrowserViewOwner) => IBrowserViewNetwork | undefined, scope?: IAgentBrowserHostScope): IDisposable {
	const handlers = new DisposableStore();
	const router = browserHostRouter(mainProcessService);
	const hostId = scope?.providerId ?? 'local-agent-host';
	const host = { client, scope };
	if (router.hosts.has(hostId)) { throw new Error('Browser host is already registered'); }
	router.hosts.set(hostId, host);
	const frontend = (id: string) => scope?.toFrontendIdentity(id) ?? id;
	const sessions = new Set<string>();
	const trackThread = (id: string): string => { const thread = frontend(id); sessions.add(thread); return thread; };
	let cancellation = new AbortController();
	handlers.add(toDisposable(() => {
		cancellation.abort(); router.hosts.delete(hostId);
		if (!router.hosts.size) { router.listener?.dispose(); router.listener = undefined; router.targets.clear(); }
		if (sessions.size) { void mainProcessService.getChannel('browserHost').call('retireConnection', { threadIds: [...sessions] }).catch(() => { }); }
	}));
	const channel = mainProcessService.getChannel('browserHost');
	const sharedPages = new Set<string>();
	const revokeSharing = (): void => {
		for (const targetId of sharedPages) { void channel.call('sharing', { id: generateUuid(), params: { targetId, threadIds: [] } }).catch(() => { }); }
		sharedPages.clear();
	};
	handlers.add(toDisposable(revokeSharing));
	let preferenceUpdate: Promise<unknown> = Promise.resolve();
	const applyPreference = (): void => {
		if (handlers.isDisposed || client.state !== 'ready') { return; }
		const preference = {
			enabled: configuration.getValue<boolean>(BrowserChatToolsSettingId) !== false,
			cdpEnabled: configuration.getValue<boolean>(BrowserCDPSettingId) === true,
		};
		// Apply revocation in Main immediately; serialize backend updates in the same order.
		const applied = scope ? Promise.resolve() : channel.call('configure', preference);
		void applied.catch(() => { });
		preferenceUpdate = preferenceUpdate.catch(() => { }).then(async () => {
			await applied;
			if (!handlers.isDisposed && client.state === 'ready') { await client.request(APP_SERVER_METHODS['browser/configure'], preference); }
		});
		void preferenceUpdate.catch(error => {
			console.error('Could not apply browser capability settings', error);
		});
	};
	const ready = async (): Promise<void> => {
		await preferenceUpdate;
		if (handlers.isDisposed || configuration.getValue<boolean>(BrowserChatToolsSettingId) === false) { throw new Error('BrowserCapabilityUnavailable'); }
	};
	const canvasReady = (): void => {
		if (configuration.getValue<boolean>(CanvasesEnabledSettingId) === false || configuration.getValue<boolean>(ChatAIDisabledSettingId) === true) { throw new Error('CanvasCapabilityUnavailable'); }
	};
	handlers.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(BrowserChatToolsSettingId) || event.affectsConfiguration(BrowserCDPSettingId)) { applyPreference(); }
	}));
	handlers.add(toDisposable(() => {
		if (!scope && router.hosts.size === 1) { void channel.call('configure', { enabled: false, cdpEnabled: false }).catch(() => { }); }
	}));
	handlers.add(channel.listen<BrowserViewEvent>('onDidEvent')(event => {
		if (event.type === 'closed' && sharedPages.delete(event.targetId)) {
			void client.request(APP_SERVER_METHODS['browser/sharing/set'], { targetId: event.targetId, threadIds: [] }).catch(error => console.error('Closed browser page authorization release failed', error));
		}
	}));
	handlers.add(client.onStateChange(state => {
		if (state === 'ready') { applyPreference(); }
		else {
			revokeSharing();
			cancellation.abort(); cancellation = new AbortController();
			if (sessions.size) { void channel.call('retireConnection', { threadIds: [...sessions] }).catch(() => { }); }
			sessions.clear();
		}
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/sharing/set'], async (params, context) => {
		await ready();
		// Reserve before Main IPC: a close event can precede the successful grant response.
		if (params.threadIds.length) { sharedPages.add(params.targetId); router.targets.set(params.targetId, hostId); } else sharedPages.delete(params.targetId);
		try { return decodeAppServerServerRequestResult('browser/sharing/set', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('sharing', { id, params: { ...params, threadIds: params.threadIds.map(trackThread) } }))); }
		catch (error) { sharedPages.delete(params.targetId); throw error; }
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], async (params, context) => {
		const threadId = trackThread(params.threadId);
		const network = resolveNetwork ? resolveNetwork({ type: 'agent', sessionId: threadId }) ?? null : undefined;
		await ready();
		if (!params.canvas) { return decodeAppServerServerRequestResult('browser/create', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('create', { id, params: { ...params, threadId }, ...(network !== undefined ? { network } : {}) }))); }
		canvasReady();
		const request = { sessionId: params.canvas.sessionId, threadId: params.threadId, instanceId: params.canvas.instanceId };
		const state = { id: generateUuid(), succeeded: false };
		canvases?.acceptCanvasOpen(request, state);
		let resolved = params;
		let presentation: { readonly url: string; readonly title?: string; readonly status?: string; } | undefined;
		if (params.canvas.definition) {
			if (!canvases) { throw new Error('CanvasCapabilityUnavailable'); }
			const source = await canvases.openCanvasSource({ ...request, definition: params.canvas.definition }, context.signal);
			presentation = source;
			const url = new URL(source.url);
			if (url.username || url.password || source.url.length > 8192 || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) { throw new Error('CanvasSourceDenied'); }
			canvasReady();
			resolved = { ...params, url: source.url, canvas: { ...params.canvas, title: source.title ?? params.canvas.title } };
		}
		const existing = decodeAppServerServerRequestResult('browser/list', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('list', { id, params: { threadId } })));
		for (const page of existing.pages) { router.targets.set(page.targetId, hostId); }
		context.signal.throwIfAborted();
		const result = decodeAppServerServerRequestResult('browser/create', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('create', { id, params: { ...resolved, threadId, canvas: { ...resolved.canvas!, sessionId: frontend(resolved.canvas!.sessionId) } }, ...(scope ? { providerId: scope.providerId } : {}), ...(network !== undefined ? { network } : {}) })));
		canvases?.acceptCanvasOpen(request, { ...state, succeeded: true }, presentation);
		return result;
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/canvases/list'], async (params, context) => {
		await ready(); canvasReady();
		if (!canvases) { throw new Error('CanvasCapabilityUnavailable'); }
		return decodeAppServerServerRequestResult('browser/canvases/list', { canvases: await canvases.listCanvases(params.sessionId, params.threadId, context.signal) ?? null });
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/list'], async (params, context) => {
		await ready();
		return decodeAppServerServerRequestResult('browser/list', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('list', { id, params: { ...params, threadId: trackThread(params.threadId) } })));
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/observe'], async (params, context) => {
		await ready();
		return call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => playwrightService.getObservation(id, trackThread(params.threadId), params.targetId, params, params.networkToken));
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/perform'], async (params, context) => {
		await ready();
		if (params.action.type === 'cdp') {
			if (configuration.getValue<boolean>(BrowserCDPSettingId) !== true) { throw new Error('BrowserCDPDisabled'); }
			return decodeAppServerServerRequestResult('browser/perform', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('perform', { id, params: { ...params, threadId: trackThread(params.threadId) } })));
		}
		const output = await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => playwrightService.performAction(id, trackThread(params.threadId), params.action.targetId, params.action, params.networkToken));
		return { targetId: params.action.targetId, ...(output === undefined ? {} : { output }) };
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/close'], async (params, context) => {
		await ready();
		await canvases?.closeCanvasSource(params.threadId, params.targetId, context.signal);
		return decodeAppServerServerRequestResult('browser/close', await call(AbortSignal.any([context.signal, cancellation.signal]), playwrightService, id => channel.call('close', { id, params: { ...params, threadId: trackThread(params.threadId) } })));
	}));
	applyPreference();
	return handlers;
}

async function call<T>(signal: AbortSignal, playwrightService: IPlaywrightService, execute: (id: string) => Promise<T>): Promise<T> {
	const id = generateUuid();
	signal.throwIfAborted();
	const cancel = (): void => { void playwrightService.cancelOperation(id).catch(error => console.error('Browser operation cancellation failed', error)); };
	signal.addEventListener('abort', cancel, { once: true });
	try { return await execute(id); } finally { signal.removeEventListener('abort', cancel); }
}

interface BrowserHostRoute {
	readonly client: AppServerProtocolClient;
	readonly scope: IAgentBrowserHostScope | undefined;
}
interface BrowserHostRouter {
	readonly hosts: Map<string, BrowserHostRoute>;
	readonly targets: Map<string, string>;
	listener?: IDisposable;
}
const routers = new WeakMap<IMainProcessService, BrowserHostRouter>();

/** One window channel routes native callbacks to the connection that owns the page or sharing grant. */
function browserHostRouter(main: IMainProcessService): BrowserHostRouter {
	let router = routers.get(main);
	if (!router) {
		router = { hosts: new Map(), targets: new Map() };
		routers.set(main, router);
		const routes = router;
		main.registerChannel('browserSharing', {
			call: async <T>(_context: string, command: string, arg: unknown): Promise<T> => {
				if (command !== 'setSharing' || !Array.isArray(arg) || arg.length !== 2) { throw new TypeError('Invalid browser sharing command'); }
				const params = decodeAppServerRequestParams('browser/sharing/set', { targetId: arg[0], threadIds: arg[1] });
				const owners = new Set(params.threadIds.map(id => routeThread(routes, id)));
				if (owners.size > 1) { throw new Error('BrowserSharingAcrossHostsDenied'); }
				const id = owners.values().next().value ?? routes.targets.get(params.targetId) ?? 'local-agent-host';
				const host = routes.hosts.get(id);
				if (!host) { throw new Error('BrowserCapabilityUnavailable'); }
				const previousId = routes.targets.get(params.targetId);
				const previous = previousId && previousId !== id ? routes.hosts.get(previousId) : undefined;
				if (previous) { await previous.client.request(APP_SERVER_METHODS['browser/sharing/set'], { targetId: params.targetId, threadIds: [] }); }
				routes.targets.set(params.targetId, id);
				return await host.client.request(APP_SERVER_METHODS['browser/sharing/set'], { ...params, threadIds: params.threadIds.map(id => host.scope?.toBackendIdentity(id) ?? id) }) as T;
			},
			listen: <T>(): Event<T> => { throw new Error('Browser sharing has no events'); },
		});
	}
	if (!router.listener) {
		const routes = router;
		const channel = main.getChannel('browserHost');
		router.listener = channel.listen<BrowserViewEvent>('onDidEvent')(event => {
			if ((event.type === 'created' || event.type === 'canvasOpened') && event.info.owner.type === 'agent') {
				routes.targets.set(event.info.id, routeThread(routes, event.info.owner.sessionId));
			} else if (event.type === 'closed') {
				routes.targets.delete(event.targetId);
			} else if (event.type === 'networkRequested') {
				const id = routes.targets.get(event.targetId);
				const host = id && routes.hosts.get(id);
				void (async () => {
					let allowed = false;
					try { allowed = !!host && (await host.client.request(APP_SERVER_METHODS['browser/network/authorize'], { networkToken: event.networkToken, url: event.url, method: event.method })).allowed; }
					finally { await channel.call('network', { targetId: event.targetId, requestId: event.requestId, allowed }); }
				})().catch(error => console.error('Browser network authorization failed', error));
			}
		});
	}
	return router;
}

function routeThread(router: BrowserHostRouter, threadId: string): string {
	for (const [id, host] of router.hosts) { if (host.scope?.toBackendIdentity(threadId) !== undefined) { return id; } }
	return 'local-agent-host';
}

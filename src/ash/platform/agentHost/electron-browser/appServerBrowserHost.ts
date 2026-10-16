import { generateUuid } from '../../../base/common/uuid.js';
import { APP_SERVER_SERVER_REQUESTS, APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerRequestParams, decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../browser/appServerProtocolClient.js';
import type { BrowserViewEvent } from '../../browserView/common/browserView.js';
import type { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import type { Event } from '../../../base/common/event.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import { BrowserCDPSettingId, BrowserChatToolsSettingId } from '../../browserView/common/browserView.js';

export function registerAppServerBrowserHost(client: AppServerProtocolClient, playwrightService: IPlaywrightService, mainProcessService: IMainProcessService, configuration: IConfigurationService): IDisposable {
	const handlers = new DisposableStore();
	mainProcessService.registerChannel('browserSharing', {
		call: async <T>(_context: string, command: string, arg: unknown): Promise<T> => {
			if (handlers.isDisposed) { throw new Error('BrowserCapabilityUnavailable'); }
			if (command !== 'setSharing' || !Array.isArray(arg) || arg.length !== 2) { throw new TypeError('Invalid browser sharing command'); }
			const params = decodeAppServerRequestParams('browser/sharing/set', { targetId: arg[0], threadIds: arg[1] });
			return await client.request(APP_SERVER_METHODS['browser/sharing/set'], params) as T;
		},
		listen: <T>(): Event<T> => { throw new Error('Browser sharing has no events'); },
	});
	const channel = mainProcessService.getChannel('browserHost');
	const sharedPages = new Set<string>();
	let preferenceUpdate: Promise<unknown> = Promise.resolve();
	const applyPreference = (): void => {
		if (handlers.isDisposed || client.state !== 'ready') { return; }
		const preference = {
			enabled: configuration.getValue<boolean>(BrowserChatToolsSettingId) !== false,
			cdpEnabled: configuration.getValue<boolean>(BrowserCDPSettingId) === true,
		};
		// Apply revocation in Main immediately; serialize backend updates in the same order.
		const applied = channel.call('configure', preference);
		void applied.catch(() => { });
		preferenceUpdate = preferenceUpdate.catch(() => { }).then(async () => {
			await applied;
			if (!handlers.isDisposed && client.state === 'ready') { await client.request(APP_SERVER_METHODS['browser/configure'], preference); }
		});
		void preferenceUpdate.catch(error => {
			void channel.call('configure', { enabled: false, cdpEnabled: false }).catch(() => { });
			console.error('Could not apply browser capability settings', error);
		});
	};
	const ready = async (): Promise<void> => {
		await preferenceUpdate;
		if (handlers.isDisposed || configuration.getValue<boolean>(BrowserChatToolsSettingId) === false) { throw new Error('BrowserCapabilityUnavailable'); }
	};
	handlers.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(BrowserChatToolsSettingId) || event.affectsConfiguration(BrowserCDPSettingId)) { applyPreference(); }
	}));
	handlers.add(toDisposable(() => {
		void channel.call('configure', { enabled: false, cdpEnabled: false }).catch(() => { });
	}));
	handlers.add(channel.listen<BrowserViewEvent>('onDidEvent')(event => {
		if (event.type === 'networkRequested') {
			void (async () => {
				let allowed = false;
				try { allowed = (await client.request(APP_SERVER_METHODS['browser/network/authorize'], { networkToken: event.networkToken, url: event.url, method: event.method })).allowed; }
				finally { await channel.call('network', { targetId: event.targetId, requestId: event.requestId, allowed }); }
			})().catch(error => console.error('Browser network authorization failed', error));
		}
		if (event.type === 'closed' && sharedPages.delete(event.targetId)) {
			void client.request(APP_SERVER_METHODS['browser/sharing/set'], { targetId: event.targetId, threadIds: [] }).catch(error => console.error('Closed browser page authorization release failed', error));
		}
	}));
	handlers.add(client.onStateChange(state => {
		if (state === 'ready') { applyPreference(); }
		else {
			sharedPages.clear();
			void channel.call('configure', { enabled: false, cdpEnabled: false }).catch(() => { });
		}
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/sharing/set'], async (params, context) => {
		await ready();
		// Reserve before Main IPC: a close event can precede the successful grant response.
		if (params.threadIds.length) sharedPages.add(params.targetId); else sharedPages.delete(params.targetId);
		try { return decodeAppServerServerRequestResult('browser/sharing/set', await call(context.signal, playwrightService, id => channel.call('sharing', { id, params }))); }
		catch (error) { sharedPages.delete(params.targetId); throw error; }
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], async (params, context) => {
		await ready();
		return decodeAppServerServerRequestResult('browser/create', await call(context.signal, playwrightService, id => channel.call('create', { id, params })));
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/list'], async (params, context) => {
		await ready();
		return decodeAppServerServerRequestResult('browser/list', await call(context.signal, playwrightService, id => channel.call('list', { id, params })));
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/observe'], async (params, context) => {
		await ready();
		return call(context.signal, playwrightService, id => playwrightService.getObservation(id, params.threadId, params.targetId, params, params.networkToken));
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/perform'], async (params, context) => {
		await ready();
		if (params.action.type === 'cdp') {
			if (configuration.getValue<boolean>(BrowserCDPSettingId) !== true) { throw new Error('BrowserCDPDisabled'); }
			return decodeAppServerServerRequestResult('browser/perform', await call(context.signal, playwrightService, id => channel.call('perform', { id, params })));
		}
		const output = await call(context.signal, playwrightService, id => playwrightService.performAction(id, params.threadId, params.action.targetId, params.action, params.networkToken));
		return { targetId: params.action.targetId, ...(output === undefined ? {} : { output }) };
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/close'], async (params, context) => {
		await ready();
		return decodeAppServerServerRequestResult('browser/close', await call(context.signal, playwrightService, id => channel.call('close', { id, params })));
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

import { generateUuid } from '../../../base/common/uuid.js';
import { APP_SERVER_SERVER_REQUESTS, APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../browser/appServerProtocolClient.js';
import type { BrowserViewEvent } from '../../browserView/common/browserView.js';
import type { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';

export function registerAppServerBrowserHost(client: AppServerProtocolClient, playwrightService: IPlaywrightService, mainProcessService: IMainProcessService): IDisposable {
	const handlers = new DisposableStore();
	const channel = mainProcessService.getChannel('browserHost');
	const sharedPages = new Set<string>();
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
	handlers.add(client.onStateChange(state => { if (state !== 'ready') sharedPages.clear(); }));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/sharing/set'], async (params, context) => {
		// Reserve before Main IPC: a close event can precede the successful grant response.
		if (params.threadIds.length) sharedPages.add(params.targetId); else sharedPages.delete(params.targetId);
		try { return decodeAppServerServerRequestResult('browser/sharing/set', await call(context.signal, playwrightService, id => channel.call('sharing', { id, params }))); }
		catch (error) { sharedPages.delete(params.targetId); throw error; }
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], async (params, context) => decodeAppServerServerRequestResult('browser/create', await call(context.signal, playwrightService, id => channel.call('create', { id, params })))));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/observe'], (params, context) => call(context.signal, playwrightService, id => playwrightService.getObservation(id, params.threadId, params.targetId, params, params.networkToken))));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/perform'], async (params, context) => {
		await call(context.signal, playwrightService, id => playwrightService.performAction(id, params.threadId, params.action.targetId, params.action, params.networkToken));
		return { targetId: params.action.targetId };
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/close'], async (params, context) => decodeAppServerServerRequestResult('browser/close', await call(context.signal, playwrightService, id => channel.call('close', { id, params })))));
	return handlers;
}

async function call<T>(signal: AbortSignal, playwrightService: IPlaywrightService, execute: (id: string) => Promise<T>): Promise<T> {
	const id = generateUuid();
	signal.throwIfAborted();
	const cancel = (): void => { void playwrightService.cancelOperation(id).catch(error => console.error('Browser operation cancellation failed', error)); };
	signal.addEventListener('abort', cancel, { once: true });
	try { return await execute(id); } finally { signal.removeEventListener('abort', cancel); }
}

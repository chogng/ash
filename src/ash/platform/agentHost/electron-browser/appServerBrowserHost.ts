import { generateUuid } from '../../../base/common/uuid.js';
import { APP_SERVER_SERVER_REQUESTS, APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../browser/appServerProtocolClient.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { BROWSER_VIEW_EVENT_CHANNEL, type BrowserViewEvent } from '../../browserView/common/browserView.js';

export function registerAppServerBrowserHost(client: AppServerProtocolClient): IDisposable {
	const handlers = new DisposableStore();
	const sharedPages = new Set<string>();
	const pageEvents = subscribe<BrowserViewEvent>(BROWSER_VIEW_EVENT_CHANNEL, event => {
		if (event.type === 'networkRequested') {
			void (async () => {
				let allowed = false;
				try { allowed = (await client.request(APP_SERVER_METHODS['browser/network/authorize'], { networkToken: event.networkToken, url: event.url, method: event.method })).allowed; }
				finally { await invoke('ash:browser-host:network', { targetId: event.targetId, requestId: event.requestId, allowed }); }
			})().catch(error => console.error('Browser network authorization failed', error));
		}
		if (event.type === 'closed' && sharedPages.delete(event.targetId)) {
			void client.request(APP_SERVER_METHODS['browser/sharing/set'], { targetId: event.targetId, threadIds: [] }).catch(error => console.error('Closed browser page authorization release failed', error));
		}
	});
	handlers.add(toDisposable(() => pageEvents.dispose()));
	handlers.add(client.onStateChange(state => { if (state !== 'ready') sharedPages.clear(); }));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/sharing/set'], async (params, context) => {
		// Reserve before Main IPC: a close event can precede the successful grant response.
		if (params.threadIds.length) sharedPages.add(params.targetId); else sharedPages.delete(params.targetId);
		try { return decodeAppServerServerRequestResult('browser/sharing/set', await call('ash:browser-host:sharing', params, context.signal)); }
		catch (error) { sharedPages.delete(params.targetId); throw error; }
	}));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], async (params, context) => decodeAppServerServerRequestResult('browser/create', await call('ash:browser-host:create', params, context.signal))));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/observe'], async (params, context) => decodeAppServerServerRequestResult('browser/observe', await call('ash:browser-host:observe', params, context.signal))));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/perform'], async (params, context) => decodeAppServerServerRequestResult('browser/perform', await call('ash:browser-host:perform', params, context.signal))));
	handlers.add(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/close'], async (params, context) => decodeAppServerServerRequestResult('browser/close', await call('ash:browser-host:close', params, context.signal))));
	return handlers;
}

async function call(channel: string, params: unknown, signal: AbortSignal): Promise<unknown> {
	const id = generateUuid();
	signal.throwIfAborted();
	const pending = invoke(channel, { id, params });
	const cancel = (): void => { void invoke('ash:browser-host:cancel', { id }).catch(error => console.error('Browser operation cancellation failed', error)); };
	signal.addEventListener('abort', cancel, { once: true });
	try { return await pending; } finally { signal.removeEventListener('abort', cancel); }
}

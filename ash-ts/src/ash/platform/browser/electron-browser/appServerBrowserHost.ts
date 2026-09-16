import { generateUuid } from '../../../base/common/uuid.js';
import { APP_SERVER_SERVER_REQUESTS } from '../../app-server/common/generated/index.js';
import { decodeAppServerServerRequestResult } from '../../app-server/common/generated/AppServerProtocolDecoder.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';

export function registerAppServerBrowserHost(client: AppServerProtocolClient): IDisposable {
	const handlers = new DisposableStore();
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

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { IAppServerApi } from '../../../agentHost/common/appServerApi.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';
import { AppServerDebugAdapterProcessService } from '../../browser/appServerDebugAdapterProcessService.js';
import type { IDebugAdapterProcessStartOptions } from '../../common/debugAdapterProcessService.js';

test('Debug adapter startup preserves executable and connection options across the App Server boundary', async () => {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const requests: unknown[] = [];
	function emit(event: string, value: unknown): void {
		for (const listener of listeners.get(event) ?? []) { listener(value); }
	}
	const transport: AppServerTransport = {
		on(event, listener) {
			const handlers = listeners.get(event) ?? new Set();
			handlers.add(listener);
			listeners.set(event, handlers);
		},
		off(event, listener) { listeners.get(event)?.delete(listener); },
		send(event, payload) {
			if (event === WEB_APP_SERVER_CONNECT_EVENT) {
				emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'workspace', workspaceRoot: '/workspace' });
				return;
			}
			if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
			const request = JSON.parse((payload as { frame: string; }).frame) as { id?: number; method: string; params: unknown; };
			if (request.id === undefined) { return; }
			if (request.method === 'debug/adapter/start') { requests.push(request.params); }
			else { assert.equal(request.method, 'initialize'); }
			const result = request.method === 'initialize' ? createTestInitializeResult() : { sessionId: `adapter-${requests.length}` };
			emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
		},
	};
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerDebugAdapterProcessService(client, {} as IAppServerApi);
		const options: readonly IDebugAdapterProcessStartOptions[] = [
			{ dirId: 'workspace', program: 'adapter', arguments: ['--stdio'], cwd: '/workspace', env: { KEEP: 'value', REMOVE: null } },
			{ dirId: 'workspace', connection: { type: 'server', port: 4711, host: '::1' }, arguments: [] },
			{ dirId: 'workspace', connection: { type: 'namedPipe', path: '/tmp/adapter.sock' }, arguments: [] },
		];
		const sessions: string[] = [];
		for (const option of options) { sessions.push(await service.start(option)); }
		assert.deepEqual({ requests, sessions }, { requests: options, sessions: ['adapter-1', 'adapter-2', 'adapter-3'] });
	} finally {
		client.dispose();
	}
});

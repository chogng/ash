import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { IAppServerApi } from '../../../agentHost/common/appServerApi.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';
import { AppServerDebugAdapterProcessService } from '../../browser/appServerDebugAdapterProcessService.js';
import type { IDebugAdapterProcessStartOptions } from '../../common/debugAdapterProcessService.js';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';

test('Debug adapter handles isolate identical backend IDs across folders and retired sessions', async () => {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const requests: { method: string; params: unknown; }[] = [];
	let failClose = false;
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
			if (request.method !== 'initialize') { requests.push({ method: request.method, params: request.params }); }
			if (request.method === 'debug/adapter/close' && failClose) {
				emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'injected close failure', data: { kind: 'DebugAdapterOperationFailed' } } }) });
				return;
			}
			const result = request.method === 'initialize' ? createTestInitializeResult()
				: request.method === 'debug/adapter/start' ? { sessionId: 'adapter-1' }
					: request.method === 'debug/adapter/read' ? { messages: [], nextSequence: 0, outputGap: false, stderr: '', exited: false, exitCode: null, protocolError: null } : null;
			emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
		},
	};
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerDebugAdapterProcessService(client, {} as IAppServerApi);
		const start = (dirId?: string) => service.start({ dirId, program: 'adapter', arguments: [] });
		const [first, second, folderless] = await Promise.all([start('first'), start('second'), start()]);
		assert.equal(new Set([first, second, folderless]).size, 3);
		requests.length = 0;
		await service.send(first, { command: 'continue' });
		await service.read(second, 7, 20);
		await service.send(folderless, { command: 'pause' });
		await service.close(first);
		await service.send(second, { command: 'next' });
		assert.deepEqual(requests, [
			{ method: 'debug/adapter/send', params: { dirId: 'first', sessionId: 'adapter-1', message: { command: 'continue' } } },
			{ method: 'debug/adapter/read', params: { dirId: 'second', sessionId: 'adapter-1', afterSequence: 7, maxMessages: 20 } },
			{ method: 'debug/adapter/send', params: { sessionId: 'adapter-1', message: { command: 'pause' } } },
			{ method: 'debug/adapter/close', params: { dirId: 'first', sessionId: 'adapter-1' } },
			{ method: 'debug/adapter/send', params: { dirId: 'second', sessionId: 'adapter-1', message: { command: 'next' } } },
		]);
		const replacement = await start('first');
		assert.notEqual(replacement, first);
		const requestCount = requests.length;
		await assert.rejects(service.send(first, {}), /no longer available/);
		await assert.rejects(service.read(first, 0, 20), /no longer available/);
		await service.close(first);
		assert.equal(requests.length, requestCount);
		failClose = true;
		await assert.rejects(service.close(second), /injected close failure/);
		await assert.rejects(service.send(second, {}), /no longer available/);
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
		try {
			await assert.rejects(service.read(second, 0, 20), { message: '调试适配器会话已不可用。' });
		} finally {
			resetNlsResolver();
		}
		failClose = false;
		await service.close(replacement);
		await service.close(folderless);
	} finally {
		client.dispose();
	}
});

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
		assert.deepEqual(requests, options);
		assert.equal(new Set(sessions).size, options.length);
	} finally {
		client.dispose();
	}
});

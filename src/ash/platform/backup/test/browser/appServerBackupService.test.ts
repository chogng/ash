import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';
import { AppServerBackupService } from '../../browser/appServerBackupService.js';
import { BackupError } from '../../common/backup.js';

function record(index: number): { content: { resource: string; format: string; content: string; }; revision: string; updatedAt: number; } {
	return { content: { resource: `untitled:note-${index}`, format: 'text.v1', content: `draft ${index}` }, revision: `revision-${index}`, updatedAt: index };
}

class Transport implements AppServerTransport {
	public readonly requests: { method: string; params: Record<string, unknown>; }[] = [];
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

	constructor(private readonly mode: 'pages' | 'legacy' | 'stalled' | 'failed' = 'pages') { }

	public on(event: string, listener: (value: unknown) => void): void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
	}

	public off(event: string, listener: (value: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' });
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT) {
			return;
		}
		const request = JSON.parse((payload as { frame: string; }).frame) as { id?: number; method: string; params: Record<string, unknown>; };
		if (request.id === undefined) {
			return;
		}
		this.requests.push(request);
		let result: unknown;
		let error: { code: number; message: string; data: { kind: string; }; } | undefined;
		if (request.method === 'initialize') {
			result = createTestInitializeResult();
		} else if (request.method === 'backup/list') {
			result = { backups: [record(0), record(1)] };
		} else if (request.method === 'backup/listPage') {
			if (this.mode === 'legacy') {
				error = { code: -32601, message: 'MethodNotFound', data: { kind: 'MethodNotFound' } };
			} else if (this.mode === 'failed' && request.params.afterResource !== null) {
				error = { code: -32000, message: 'BackupOperationFailed', data: { kind: 'BackupOperationFailed' } };
			} else if (this.mode === 'stalled' || request.params.afterResource === null) {
				result = { backups: [record(0)], nextResource: record(0).content.resource };
			} else {
				assert.equal(request.params.afterResource, record(0).content.resource);
				result = { backups: [record(1)], nextResource: null };
			}
		} else {
			throw new Error(`Unexpected method: ${request.method}`);
		}
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) });
	}

	private emit(event: string, value: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(value);
		}
	}
}

test('Backup recovery follows all pages through the generated protocol', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const result = await new AppServerBackupService(client, 'editor').list('workspace');
		assert.deepEqual(result, [0, 1].map(index => ({ ...record(index), content: { ...record(index).content, resource: URI.parse(record(index).content.resource) } })));
		assert.deepEqual(transport.requests.filter(request => request.method === 'backup/listPage').map(request => request.params), [
			{ clientId: 'editor', workspaceId: 'workspace', afterResource: null },
			{ clientId: 'editor', workspaceId: 'workspace', afterResource: record(0).content.resource },
		]);
	} finally {
		client.dispose();
	}
});

test('Backup recovery supports an older server with the original list method', async () => {
	const transport = new Transport('legacy');
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		assert.equal((await new AppServerBackupService(client, 'editor').list('workspace')).length, 2);
		assert.deepEqual(transport.requests.slice(1).map(request => request.method), ['backup/listPage', 'backup/list']);
	} finally {
		client.dispose();
	}
});

for (const mode of ['stalled', 'failed'] as const) {
	test(`Backup recovery rejects a ${mode} continuation without returning partial content`, async () => {
		const transport = new Transport(mode);
		const client = new AppServerProtocolClient(transport);
		try {
			await client.connect();
			await assert.rejects(new AppServerBackupService(client, 'editor').list('workspace'), error => error instanceof BackupError && error.code === 'failed');
			assert.equal(transport.requests.filter(request => request.method === 'backup/listPage').length, 2);
		} finally {
			client.dispose();
		}
	});
}

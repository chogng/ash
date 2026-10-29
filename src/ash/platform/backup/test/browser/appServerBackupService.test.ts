import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';
import { AppServerBackupService } from '../../browser/appServerBackupService.js';
import { BackupError } from '../../common/backup.js';

ensureNoDisposablesAreLeakedInTestSuite();

function record(index: number): { content: { resource: string; format: string; content: string; }; revision: string; updatedAt: number; } {
	return { content: { resource: `untitled:note-${index}`, format: 'text.v1', content: `draft ${index}` }, revision: `revision-${index}`, updatedAt: index };
}

class Transport implements AppServerTransport {
	public readonly requests: { method: string; params: Record<string, unknown>; }[] = [];
	public onWrite: (() => void) | undefined;
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
		} else if (request.method === 'backup/write') {
			if (this.onWrite) { this.onWrite(); return; }
			result = record(0);
		} else if (request.method === 'backup/move') {
			if (this.mode === 'legacy') error = { code: -32601, message: 'MethodNotFound', data: { kind: 'MethodNotFound' } };
			else if (this.mode === 'failed') error = { code: -32003, message: 'BackupRevisionConflict', data: { kind: 'BackupRevisionConflict' } };
			else result = { backups: [{ resource: 'untitled:note-0', revision: 'moved' }] };
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

	public closeAfterWrite(): void {
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Lost backup write reply' });
	}
}

test('backup shutdown writes wait for replacement initialization and preserve the expected revision', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	client.disconnect();
	const resource = URI.parse(record(0).content.resource);
	const writing = new AppServerBackupService(client, 'editor').store({ id: 'workspace', folders: [] }, { ...record(0).content, resource }, 'previous');
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(transport.requests.filter(request => request.method === 'backup/write').length, 0);
	await client.connect();
	assert.deepEqual(await writing, { ...record(0), content: { ...record(0).content, resource } });
	assert.deepEqual(transport.requests.filter(request => request.method === 'backup/write').map(request => request.params), [{
		clientId: 'editor', workspace: { id: 'workspace', folders: [], configuration: null, remoteAuthority: null },
		content: record(0).content, expectedRevision: 'previous',
	}]);
});

test('a backup write with a lost reply fails and is never replayed after reconnect', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	transport.onWrite = () => transport.closeAfterWrite();
	const backups = new AppServerBackupService(client, 'editor');
	await assert.rejects(backups.store({ id: 'workspace', folders: [] }, { ...record(0).content, resource: URI.parse(record(0).content.resource) }, 'previous'), /Lost backup write reply/);
	await client.connect();
	assert.equal((await backups.list('workspace')).length, 2);
	assert.equal(transport.requests.filter(request => request.method === 'backup/write').length, 1);
});

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

test('Backup migration uses one generated transaction request and revives only moved revisions', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const resource = URI.parse('untitled:note-0');
	const moved = await new AppServerBackupService(client, 'editor').move('old', { id: 'new', folders: [URI.file('/root')], configuration: URI.file('/team.ash-workspace') }, [{ resource, revision: 'source' }]);
	assert.deepEqual(moved, [{ resource, revision: 'moved' }]);
	assert.deepEqual(transport.requests.slice(1).map(({ method, params }) => ({ method, params })), [{ method: 'backup/move', params: { clientId: 'editor', sourceWorkspaceId: 'old', workspace: { id: 'new', folders: [URI.file('/root').toString()], configuration: URI.file('/team.ash-workspace').toString(), remoteAuthority: null }, backups: [{ resource: resource.toString(), revision: 'source' }] } }]);
});

for (const mode of ['legacy', 'failed'] as const) test(`Backup migration ${mode} does not fall back to nontransactional writes`, async () => {
	const transport = new Transport(mode);
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	await assert.rejects(new AppServerBackupService(client, 'editor').move('old', { id: 'new', folders: [] }, []), error => mode === 'legacy'
		? error instanceof AppServerRemoteError && error.code === -32601
		: error instanceof BackupError && error.code === 'conflict');
	assert.deepEqual(transport.requests.slice(1).map(request => request.method), ['backup/move']);
});

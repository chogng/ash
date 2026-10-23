import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { AppServerChannelService } from '../../browser/appServerChannelService.js';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import type { ChannelConnection, AppServerErrorName } from '../../../../../../.build/protocol/typescript/index.js';

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	readonly requests: { id: number; method: string; params: Record<string, unknown>; }[] = [];
	state: ChannelConnection = { serverUrl: 'https://collab.example', snapshot: { id: 'space', name: 'Team', revision: 5, memberId: 'owner', channels: [{ id: 'general', name: 'general' }], members: [{ id: 'owner', name: 'Alice', role: 'owner' }] } };
	error: AppServerErrorName | undefined;
	defer = false;
	on(event: string, listener: (value: unknown) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(listener); this.listeners.set(event, set); }
	off(event: string, listener: (value: unknown) => void) { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, value: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
	reply(id: number, result: unknown) { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, result }) }); }
	send(event: string, payload?: unknown) {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const request = JSON.parse((payload as { frame: string; }).frame) as typeof this.requests[number];
		if (request.method === 'initialize') { this.reply(request.id, createTestInitializeResult()); return; }
		if (request.method === 'initialized') return;
		this.requests.push(request);
		if (this.defer) return;
		if (this.error) { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32074, message: 'redacted', data: { kind: this.error } } }) }); return; }
		if (request.method === 'channels/disconnect') this.reply(request.id, null);
		else if (request.method === 'channels/invite' || request.method === 'channels/signInKey') this.reply(request.id, { serverUrl: this.state.serverUrl, credential: 'a'.repeat(64) });
		else if (request.method === 'channels/notes' || request.method === 'channels/call') this.reply(request.id, { serverUrl: this.state.serverUrl, resourceId: 'channel-resource', credential: 'b'.repeat(64) });
		else this.reply(request.id, this.state);
	}
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('channel adapter uses server revisions, never replays mutations, and clears revoked state', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		using service = new AppServerChannelService(client);
		await service.refresh();
		assert.equal(service.space?.name, 'Team');
		transport.error = 'ChannelConflict';
		await service.edit({ type: 'rename', channelId: 'general', name: 'renamed' });
		assert.equal(service.error, 'conflict');
		assert.equal(service.space?.channels[0]?.name, 'general');
		assert.deepEqual(transport.requests.at(-1)?.params, { spaceId: 'space', revision: 5, change: { type: 'rename', channelId: 'general', name: 'renamed' } });
		transport.error = undefined;
		transport.state.snapshot.revision = 6;
		await service.refresh();
		assert.equal(service.error, undefined);
		assert.equal(service.space?.revision, 6);
		assert.equal(transport.requests.filter(r => r.method === 'channels/edit').length, 1);
		transport.error = 'ChannelDenied';
		await service.refresh();
		assert.equal(service.error, 'denied');
		assert.equal(service.space, undefined);
	} finally { client.dispose(); }
});

test('channel watching stops with the last view and ignores responses after disposal', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerChannelService(client);
		try {
			let changes = 0;
			using listener = service.onDidChange(() => changes++);
			const watcher = service.watch();
			await flush();
			assert.equal(transport.requests.length, 1);
			mock.timers.tick(2000); await flush();
			assert.equal(transport.requests.length, 2);
			assert.equal(changes, 1, 'unchanged polls must not rebuild a focused view');
			watcher.dispose(); mock.timers.tick(5000); await flush();
			assert.equal(transport.requests.length, 2);
			transport.defer = true;
			const refresh = service.refresh(); await flush();
			const revision = service.space?.revision;
			service.dispose();
			transport.state.snapshot.revision = 99;
			transport.reply(transport.requests.at(-1)!.id, transport.state);
			await refresh;
			assert.equal(service.space?.revision, revision);
		} finally { service.dispose(); }
	} finally { client.dispose(); mock.timers.reset(); }
});


test('channel resources use scoped access and discard credentials after an account switch', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		using service = new AppServerChannelService(client);
		await service.refresh();
		const reference = { serverUrl: transport.state.serverUrl, spaceId: 'space', channelId: 'general' };
		assert.equal((await service.notes(reference)).resourceId, 'channel-resource');
		assert.deepEqual(transport.requests.at(-1)?.params, { spaceId: 'space', channelId: 'general' });
		transport.error = 'ChannelDenied';
		await assert.rejects(service.call(reference), /Channel access was denied/);
		assert.equal(service.space?.id, 'space', 'a denied start must not disconnect a read-only member');
		transport.error = undefined;
		transport.defer = true;
		const notes = service.notes(reference);
		await flush();
		const request = transport.requests.at(-1)!;
		transport.defer = false;
		await service.disconnect();
		transport.reply(request.id, { serverUrl: reference.serverUrl, resourceId: 'late-notes', credential: 'c'.repeat(64) });
		await assert.rejects(notes, { name: 'CancellationError' });
	} finally { client.dispose(); }
});

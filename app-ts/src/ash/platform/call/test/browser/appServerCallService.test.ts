import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerCallService } from '../../browser/appServerCallService.js';
import { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../app-server/common/appServerTransport.js';
import { APP_SERVER_SCHEMA_HASH, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_CAPABILITY_VERSION, type InitializeResult, type ServerCapabilities, type CallStatus } from '../../../app-server/common/generated/index.js';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';

class Transport implements AppServerTransport {
    private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
    public readonly pending: number[] = [];
    public status: CallStatus = { resourceId: '', sequence: 1, connection: 'connected', call: { id: 'call', revision: 1, mediaEpoch: 1, mediaRoom: 'room', mediaState: { state: 'ready' }, members: [{ id: 'owner', role: 'owner' }] }, memberId: 'owner', participants: [], muted: true, deafened: false, microphoneAllowed: true, screenSharing: false, error: null };
    public on(event: string, listener: (value: unknown) => void): void { const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners); }
    public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
    private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
    public reply(id: number, result: unknown): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, result }) }); }
    public changed(connection: CallStatus['connection']): void { this.status = { ...this.status, sequence: this.status.sequence + 1, connection }; this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'call/changed', params: this.status }) }); }
    public send(event: string, payload?: unknown): void {
        if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' }); return; }
        if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
        const request = JSON.parse((payload as { frame: string }).frame) as { id: number; method: string; params: { resourceId: string } };
        let result: unknown;
        if (request.method === 'initialize') {
			const capabilities = {
				agentInteractions: true,
				documentCollaboration: true,
				sessions: true,
				threads: true,
				turns: true,
				projects: true,
				memories: true,
				resources: true,
				attachments: true,
				fileSystem: true,
				git: true,
				contentSearch: true,
				codebase: true,
				cloudCodebase: true,
				terminal: true,
				debugAdapter: true,
				typst: true,
				updateReplay: true,
				extensions: true,
				extensionHost: true,
				connectors: true,
				plugins: true,
				marketplace: true,
				mcp: true,
				mcpOAuth: true,
			} satisfies Omit<ServerCapabilities, 'contracts'>;
			result = { serverInfo: { name: 'ash-app-server', version: '1' }, protocolVersion: { major: APP_SERVER_PROTOCOL_MAJOR, revision: APP_SERVER_PROTOCOL_REVISION }, schemaHash: APP_SERVER_SCHEMA_HASH, capabilities: { ...capabilities, contracts: { sessions: { version: APP_SERVER_CAPABILITY_VERSION }, threads: { version: APP_SERVER_CAPABILITY_VERSION }, turns: { version: APP_SERVER_CAPABILITY_VERSION }, memoryDiagnostics: { version: 1 } } }, slashCommands: [] } satisfies InitializeResult;
        } else if (request.method === 'call/start') { this.status.resourceId = request.params.resourceId; result = this.status; }
        else if (request.method === 'call/screenFrames') { this.pending.push(request.id); return; }
        else { throw new Error(`Unexpected request ${request.method}`); }
        this.reply(request.id, result);
    }
}

async function pending(transport: Transport): Promise<number> {
    for (let attempt = 0; attempt < 100 && transport.pending.length === 0; attempt++) { await delay(5); }
    assert.equal(transport.pending.length, 1);
    return transport.pending.shift()!;
}

const pixels = { mediaEpoch: 1, tracks: ['screen'], frames: [{ trackId: 'screen', participantId: 'speaker', jpeg: btoa('pixels') }] };

test('shared screens reject a delayed response after reconnecting in the same media room', async () => {
    const tracker = new DisposableTracker();
    using registration = installDisposableTracker(tracker);
    const transport = new Transport();
    const client = new AppServerProtocolClient(transport);
    await client.connect();
    const service = new AppServerCallService(client);
    try {
        await service.start({ type: 'local' });
        const first = await pending(transport);
        transport.changed('reconnecting');
        transport.changed('connected');
        transport.reply(first, pixels);
        await delay(5);
        assert.equal(service.screens.length, 0);
        transport.reply(await pending(transport), pixels);
        await delay(5);
        assert.equal(service.screens[0]?.participantId, 'speaker');
        transport.reply(await pending(transport), { mediaEpoch: 1, tracks: [], frames: [] });
        await delay(5);
        assert.equal(service.screens.length, 0);
        const late = await pending(transport);
        service.dispose();
        transport.reply(late, pixels);
        await delay(100);
        assert.equal(service.screens.length, 0);
        assert.deepEqual(transport.pending, []);
    } finally { service.dispose(); client.dispose(); }
    tracker.assertNoLeaks();
});

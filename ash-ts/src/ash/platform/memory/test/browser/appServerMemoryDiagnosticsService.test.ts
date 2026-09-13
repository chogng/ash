import { strict as assert } from 'node:assert';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerMemoryDiagnosticsService } from '../../browser/appServerMemoryDiagnosticsService.js';
import { AppServerProtocolClient, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, type AppServerTransport } from '../../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_SCHEMA_HASH, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_CAPABILITY_VERSION, type InitializeResult, type ServerCapabilities } from '../../../../../../generated/app-server/index.js';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';
import type { MemoryObservation } from '../../common/memoryDiagnosticsService.js';

class Transport implements AppServerTransport {
	public readonly requests: string[] = [];
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public status = 'recording';
	public on(event: string, listener: (value: unknown) => void): void { const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners); }
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string }).frame) as { id: number; method: string };
		this.requests.push(request.method);
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
		} else if (request.method === 'memoryDiagnostics/submit') { result = null; }
		else {
			if (request.method === 'memoryDiagnostics/stop') { this.status = 'stopped'; }
			if (request.method === 'memoryDiagnostics/start') { this.status = 'recording'; }
			result = { version: 1, sessionId: 'memory-1', product: 'browser', status: this.status, startedAtMs: 1, elapsedMs: 0, sampleIntervalMs: 5000, targets: [], evidenceGaps: 0 };
		}
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
	}
}

const observations: MemoryObservation[] = [{ instanceId: 'renderer-1', processId: null, role: 'renderer', phase: 'unknown', metrics: [{ kind: 'domNodes', value: 10, unavailable: null }] }];

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) { await delay(5); }
	assert.ok(condition(), 'expected lifecycle transition');
}

test('duplicate start shares one recording and stopping prevents late evidence submission', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	let release!: (value: MemoryObservation[]) => void;
	let collecting = false;
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', () => { collecting = true; return new Promise(resolve => { release = resolve; }); });
	try {
		const first = service.start();
		assert.equal(first, service.start());
		await first;
		await waitFor(() => collecting);
		const stopped = service.stop();
		release(observations);
		assert.equal((await stopped).status, 'stopped');
		assert.equal(transport.requests.filter(method => method === 'memoryDiagnostics/start').length, 1);
		assert.equal(transport.requests.filter(method => method === 'memoryDiagnostics/submit').length, 0);
	} finally { service.dispose(); client.dispose(); }
	tracker.assertNoLeaks();
});

test('connection loss stops collection and rejects evidence from the previous connection', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	let release!: (value: MemoryObservation[]) => void;
	let collecting = false;
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', () => { collecting = true; return new Promise(resolve => { release = resolve; }); });
	try {
		await service.start();
		await waitFor(() => collecting);
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'closed' });
		release(observations);
		await delay(10);
		await assert.rejects(service.read(), /interrupted/);
		assert.equal(transport.requests.filter(method => method === 'memoryDiagnostics/submit').length, 0);
	} finally { service.dispose(); client.dispose(); }
	tracker.assertNoLeaks();
});

test('stop followed immediately by start finishes cleanup before starting the next recording', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', async () => observations);
	try {
		await service.start();
		const stop = service.stop();
		const start = service.start();
		assert.equal((await stop).status, 'stopped');
		assert.equal((await start).status, 'recording');
		assert.deepEqual(transport.requests.filter(method => method === 'memoryDiagnostics/start' || method === 'memoryDiagnostics/stop'), ['memoryDiagnostics/start', 'memoryDiagnostics/stop', 'memoryDiagnostics/start']);
	} finally { service.dispose(); client.dispose(); }
	tracker.assertNoLeaks();
});

test('disposing before a queued start runs does not create backend work', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', async () => observations);
	const starting = service.start();
	service.dispose();
	await assert.rejects(starting, /disposed/i);
	assert.equal(transport.requests.filter(method => method === 'memoryDiagnostics/start').length, 0);
	client.dispose();
	tracker.assertNoLeaks();
});

test('collector failure during stop cannot leave the backend recording', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	let reject!: (reason: Error) => void;
	let collecting = false;
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', () => { collecting = true; return new Promise((_, fail) => { reject = fail; }); });
	try {
		await service.start();
		await waitFor(() => collecting);
		const stopped = service.stop();
		reject(new Error('collector failed'));
		assert.equal((await stopped).status, 'stopped');
		assert.ok(transport.requests.includes('memoryDiagnostics/stop'));
	} finally { service.dispose(); client.dispose(); }
	tracker.assertNoLeaks();
});

test('explicit retry resumes the existing recording after a collector failure', async () => {
	const tracker = new DisposableTracker();
	using registration = installDisposableTracker(tracker);
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	await client.connect();
	let calls = 0;
	const service = new AppServerMemoryDiagnosticsService(client, 'browser', async () => { if (++calls === 1) { throw new Error('collector failed'); } return observations; });
	try {
		await service.start();
		await waitFor(() => calls === 1);
		await assert.rejects(service.read(), /collector failed/);
		await service.start();
		await waitFor(() => transport.requests.includes('memoryDiagnostics/submit'));
		assert.equal(transport.requests.filter(method => method === 'memoryDiagnostics/start').length, 1);
		assert.equal((await service.stop()).status, 'stopped');
	} finally { service.dispose(); client.dispose(); }
	tracker.assertNoLeaks();
});

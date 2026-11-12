import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { getEventListeners } from 'node:events';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { AppServerGitHubService } from '../../../github/browser/appServerGitHubService.js';
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS } from '../../../../../../.build/protocol/typescript/index.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { AppServerConnectionRecovery, AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerAgentSessionService } from '../../browser/appServerAgentService.js';
import type { AgentSessionChange } from '../../common/agent.js';
import type { LogEntry } from '../../../log/common/log.js';
import { LogService } from '../../../log/common/logServiceImpl.js';
import { AppServerProtocolIncompatibleError } from '../../common/appServerProtocolCompatibility.js';
import { appServerRequest } from '../../browser/appServerRequest.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { AppServerFrame, type AppServerTransport, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../common/appServerTransport.js';
import { createTestInitializeResult, createTestModel } from '../common/testAppServerProtocol.js';
import { SSH_REMOTE_INITIALIZE_TIMEOUT_MS } from '../../../remote/common/remote.js';
import { AppServerFrameDecoder } from '../../browser/appServerFrameDecoder.js';
import { createAppServerExtensionHostApi } from '../../../extensions/browser/extensionHostApi.js';
import { createAppServerFileApi } from '../../../files/browser/fileApi.js';
import type { FileInvalidation } from '../../../files/common/fileApi.js';
import { URI } from '../../../../base/common/uri.js';
import { createAppServerResourceApi } from '../../browser/appServerApi.js';
import { AgentHostFileSystemProvider } from '../../common/agentHostFileSystemProvider.js';
import { TestAppServerDecodePort } from '../common/testAppServerDecoder.js';

ensureNoDisposablesAreLeakedInTestSuite();

class ProtocolTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	public readonly frames: Record<string, unknown>[] = [];
	public shouldCloseSynchronously = false;
	public initializeDelayMs = 0;
	public holdInitialize = false;
	public onInitialize: (() => void) | undefined;
	public onDisconnect: (() => void) | undefined;
	public rejectFrameWrites = false;
	constructor(private readonly initialize: () => unknown = createTestInitializeResult) { }

	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) { this.listeners.set(event, listeners = new Set()); }
		listeners.add(listener);
	}

	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }

	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'workspace', workspaceRoot: '/workspace' });
		} else if (event === WEB_APP_SERVER_DISCONNECT_EVENT) {
			this.onDisconnect?.();
			if (this.shouldCloseSynchronously) { this.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true }); }
		} else if (event === WEB_APP_SERVER_FRAME_EVENT) {
			if (this.rejectFrameWrites) throw new Error('Peer socket already closed');
			const frame = JSON.parse((payload as { frame: string; }).frame) as Record<string, unknown>;
			this.frames.push(frame);
			if (frame.method === 'initialize' && !this.holdInitialize) {
				const reply = () => { this.frame({ id: frame.id, result: this.initialize() }); this.onInitialize?.(); };
				if (this.initializeDelayMs) { setTimeout(reply, this.initializeDelayMs); } else { reply(); }
			}
		}
	}

	public frame(value: Record<string, unknown>): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', ...value }) }); }

	public emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }

	public hostRequest(id: string): void {
		this.frame({ id, method: 'browser/create', params: { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' } });
	}
}

const flushHandlers = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

test('Transport hello is pipelined while domain requests wait for full initialization', async () => {
	const transport = new ProtocolTransport();
	transport.holdInitialize = true;
	const client = new AppServerProtocolClient(transport, { transportHandshake: true });
	using cleanup = toDisposable(() => client.dispose());
	const connecting = client.connect();
	await flushHandlers();
	const [hello, initialize] = transport.frames;
	assert.equal(hello?.method, 'transport/hello');
	assert.equal(initialize?.method, 'initialize');
	const result = createTestInitializeResult();
	transport.frame({ id: hello?.id, result: { protocolVersion: result.protocolVersion, schemaHash: result.schemaHash } });
	await flushHandlers();
	assert.equal(client.state, 'initializing');
	assert.equal(client.capabilities, undefined);
	await assert.rejects(client.request(APP_SERVER_METHODS['config/read'], {}), /App Server is not ready: initializing/);
	transport.frame({ id: initialize?.id, result });
	await connecting;
	assert.equal(client.state, 'ready');
});

test('Transport hello falls back to the full response on peers with the old startup sequence', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport, { transportHandshake: true });
	using cleanup = toDisposable(() => client.dispose());
	const connecting = client.connect();
	await flushHandlers();
	const hello = transport.frames[0];
	assert.equal(hello?.method, 'transport/hello');
	transport.frame({ id: hello?.id, error: { code: -32001, message: 'Not initialized', data: { kind: 'NotInitialized' } } });
	await connecting;
	assert.equal(client.state, 'ready');
});

test('Concurrent config reads share one request and retry after rejection', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();

	const reads = Array.from({ length: 110 }, () => appServerRequest(client, 'config/read', {}));
	const requests = () => transport.frames.filter(frame => frame.method === 'config/read');
	assert.equal(requests().length, 1);
	const rejected = Promise.all(reads.map(read => assert.rejects(read, /ServerOverloaded/)));
	transport.frame({ id: requests()[0]?.id, error: { code: -32000, message: 'ServerOverloaded', data: { kind: 'ServerOverloaded' } } });
	await rejected;

	const retry = assert.rejects(appServerRequest(client, 'config/read', {}), /connection replaced/);
	assert.equal(requests().length, 2);
	client.disconnect();
	await retry;
});

test('Config reads stay ordered across writes, change notifications and reconnects', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = new DisposableStore();
	cleanup.add(toDisposable(() => client.dispose()));
	await client.connect();

	const pending: Promise<unknown>[] = [appServerRequest(client, 'config/read', {})];
	pending.push(appServerRequest(client, 'config/update', { commandId: 'model-switch', expectedRevision: 1, model: { provider: 'openai', model: 'next' } }));
	pending.push(appServerRequest(client, 'config/read', {}));
	cleanup.add(client.onNotification(event => {
		if (event.method === 'config/changed') {
			pending.push(appServerRequest(client, 'config/read', {}), appServerRequest(client, 'config/read', {}));
		}
	}));
	const change = { method: 'config/changed', params: { revision: 2, generation: 2 } };
	transport.frame(change);
	transport.frame(change);
	assert.equal(pending.length, 5);
	assert.deepEqual(transport.frames.map(frame => frame.method).filter(method => typeof method === 'string' && method.startsWith('config/')), [
		'config/read', 'config/update', 'config/read', 'config/read',
	]);

	const rejected = Promise.all(pending.map(request => assert.rejects(request, /connection replaced/)));
	client.disconnect();
	await client.connect();
	transport.frame(change);
	const afterReconnect = Promise.all(pending.slice(5).map(request => assert.rejects(request, /connection replaced/)));
	assert.equal(pending.length, 7);
	assert.equal(transport.frames.filter(frame => frame.method === 'config/read').length, 4);
	client.disconnect();
	await Promise.all([rejected, afterReconnect]);
});

test('File domain invalidations reach only their filesystem connection and release with their consumers', async () => {
	const transport = new ProtocolTransport();
	const otherTransport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	const otherClient = new AppServerProtocolClient(otherTransport);
	using cleanup = new DisposableStore();
	cleanup.add(toDisposable(() => client.dispose()));
	cleanup.add(toDisposable(() => otherClient.dispose()));
	const files = createAppServerFileApi(client);
	const otherFiles = createAppServerFileApi(otherClient);
	const receiver = { changes: [] as FileInvalidation[] };
	using subscriptions = new DisposableStore();
	files.onDidChangeFiles(function (this: typeof receiver, event) { this.changes.push(event); }, receiver, subscriptions);
	const root = URI.parse('ash-remote://ssh+first/repo');
	const otherRoot = URI.parse('ash-remote://ssh+second/repo');
	using provider = new AgentHostFileSystemProvider({
		api: files, resourceApi: createAppServerResourceApi(client),
		directories: () => [{ uri: root, target: { type: 'environment', dirId: 'same' } }],
	});
	using otherProvider = new AgentHostFileSystemProvider({
		api: otherFiles, resourceApi: createAppServerResourceApi(otherClient),
		directories: () => [{ uri: otherRoot, target: { type: 'environment', dirId: 'same' } }],
	});
	const observed: (readonly string[] | undefined)[] = [];
	const otherObserved: (readonly string[] | undefined)[] = [];
	cleanup.add(provider.onDidChangeFiles(event => observed.push(event.resources?.map(resource => resource.toString()))));
	cleanup.add(otherProvider.onDidChangeFiles(event => otherObserved.push(event.resources?.map(resource => resource.toString()))));
	await Promise.all([client.connect(), otherClient.connect()]);
	const changed = { method: 'fs/changed', params: { type: 'pathsChanged', dirId: 'same', paths: ['main.ts'] } };
	transport.frame(changed);
	transport.frame({ method: 'queue/changed', params: {} });
	assert.deepEqual(receiver.changes, [changed.params]);
	assert.deepEqual(observed, [[root.joinPathSegment('main.ts').toString()]]);
	assert.deepEqual(otherObserved, []);
	client.disconnect();
	transport.frame(changed);
	assert.equal(receiver.changes.length, 1);
	await client.connect();
	transport.frame({ method: 'fs/changed', params: { type: 'rescanRequired', dirId: 'same' } });
	assert.deepEqual(observed, [[root.joinPathSegment('main.ts').toString()], [root.toString()]]);
	assert.deepEqual(otherObserved, []);
	subscriptions.dispose();
	transport.frame(changed);
	assert.equal(receiver.changes.length, 2);
	assert.equal(observed.length, 3);
	provider.dispose();
	transport.frame(changed);
	assert.equal(observed.length, 3);
	otherTransport.frame(changed);
	assert.deepEqual(otherObserved, [[otherRoot.joinPathSegment('main.ts').toString()]]);
});

test('Session domain events stay on their connection across reconnects and listener disposal', async () => {
	const transport = new ProtocolTransport();
	const otherTransport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	const otherClient = new AppServerProtocolClient(otherTransport);
	using cleanup = new DisposableStore();
	cleanup.add(toDisposable(() => client.dispose()));
	cleanup.add(toDisposable(() => otherClient.dispose()));
	const sessions = createAppServerAgentSessionService(client);
	const otherSessions = createAppServerAgentSessionService(otherClient);
	const receiver = { changed: [] as AgentSessionChange[], deleted: [] as string[] };
	const otherChanges: AgentSessionChange[] = [];
	using subscriptions = new DisposableStore();
	sessions.onDidChangeSession(function (this: typeof receiver, event) { this.changed.push(event); }, receiver, subscriptions);
	sessions.onDidDeleteSession(function (this: typeof receiver, sessionId) { this.deleted.push(sessionId); }, receiver, subscriptions);
	cleanup.add(otherSessions.onDidChangeSession(event => otherChanges.push(event)));
	await Promise.all([client.connect(), otherClient.connect()]);
	const changed = { method: 'session/changed', params: { sessionId: 'same', agentTreeChanged: true } };
	const deleted = { method: 'session/deleted', params: { sessionId: 'same' } };
	transport.frame(changed);
	transport.frame(deleted);
	transport.frame({ method: 'queue/changed', params: {} });
	assert.deepEqual(receiver, { changed: [{ sessionId: 'same', agentTreeChanged: true }], deleted: ['same'] });
	assert.deepEqual(otherChanges, []);
	otherTransport.frame({ method: 'session/changed', params: { sessionId: 'same', agentTreeChanged: false } });
	assert.deepEqual(otherChanges, [{ sessionId: 'same', agentTreeChanged: false }]);
	client.disconnect();
	transport.frame(changed);
	transport.frame(deleted);
	assert.equal(receiver.changed.length, 1);
	assert.equal(receiver.deleted.length, 1);
	await client.connect();
	transport.frame(changed);
	transport.frame(deleted);
	assert.deepEqual(receiver, { changed: [changed.params, changed.params], deleted: ['same', 'same'] });
	subscriptions.dispose();
	transport.frame(changed);
	transport.frame(deleted);
	assert.equal(receiver.changed.length, 2);
	assert.equal(receiver.deleted.length, 2);
});

test('extension results wake through decoded completion notifications and stop waiting on disconnect', async () => {
	for (const outcome of ['complete', 'disconnect'] as const) {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		const pending = createAppServerExtensionHostApi(client).invoke({
			extensionId: 'acme.demo', registrationId: 'command', activationGeneration: 1,
			incarnation: 1, operation: 'execute', payload: null, deadlineUnixMillis: Date.now() + 5000,
		}, new AbortController().signal);
		const settled = outcome === 'disconnect' ? assert.rejects(pending, /closed|not ready/) : pending;
		const started = transport.frames.find(frame => frame.method === 'extensionHost/invoke/start')!;
		assert.ok(started);
		transport.frame({ id: started.id, result: { invocationId: 'eh-1-1' } });
		await flushHandlers();
		assert.equal(transport.frames.some(frame => frame.method === 'extensionHost/invoke/read'), false);
		if (outcome === 'disconnect') {
			transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'connection closed' });
			await settled;
		} else {
			transport.frame({ method: 'extensionHost/invoke/completed', params: { invocationId: 'eh-1-1' } });
			await flushHandlers();
			const reads = transport.frames.filter(frame => frame.method === 'extensionHost/invoke/read');
			assert.equal(reads.length, 1);
			transport.frame({ id: reads[0]!.id, result: { state: 'succeeded', payload: 'result' } });
			assert.equal(await settled, 'result');
		}
	}
});

test('readiness waits through replacement and initialization without opening a connection', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	await client.whenReady();
	client.disconnect();
	let ready = false;
	const waiting = client.whenReady().then(() => { ready = true; });
	await flushHandlers();
	assert.equal(ready, false);
	assert.equal(transport.frames.filter(frame => frame.method === 'initialize').length, 1);
	await assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}), /not ready: stopped/);
	await client.connect();
	await waiting;
	assert.equal(client.state, 'ready');
});

test('a planned restart preserves accepted RPCs and waits for the replacement before admitting new work', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const request = client.request(APP_SERVER_METHODS['session/list'], {});
	const id = transport.frames.at(-1)!.id;
	let drained = false;
	const drain = client.drainForRestart().then(() => { drained = true; });
	const ready = client.whenReady();
	await assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}), /connection replaced/);
	assert.equal(drained, false);
	transport.frame({ id, error: { code: -32000, message: 'old generation response', data: { kind: 'InternalError' } } });
	await assert.rejects(request, /old generation response/);
	await drain;
	client.disconnect();
	await client.connect();
	await ready;
	assert.equal(client.state, 'ready');
});

test('readiness has a bounded deadline without failing or starting the connection', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 100 });
		using cleanup = toDisposable(() => client.dispose());
		const waiting = assert.rejects(client.whenReady(), /readiness timed out/);
		mock.timers.tick(100);
		await waiting;
		assert.equal(client.state, 'stopped');
		assert.deepEqual(transport.frames, []);
		await client.connect();
		await client.whenReady();
		assert.equal(client.state, 'ready');
	} finally { mock.timers.reset(); }
});

test('readiness is not satisfied by an acquired but uninitialized connection', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		transport.initializeDelayMs = 100;
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let ready = false;
		const waiting = client.whenReady().then(() => { ready = true; });
		const connecting = client.connect();
		await flushHandlers();
		mock.timers.tick(99);
		await flushHandlers();
		assert.equal(client.state, 'initializing');
		assert.equal(ready, false);
		mock.timers.tick(1);
		await Promise.all([connecting, waiting]);
		assert.equal(client.state, 'ready');
	} finally { mock.timers.reset(); }
});

test('disposing an already stopped client rejects all readiness waits and future waits', async () => {
	const client = new AppServerProtocolClient(new ProtocolTransport());
	using cleanup = toDisposable(() => client.dispose());
	const first = assert.rejects(client.whenReady(), /client disposed/);
	const second = assert.rejects(client.whenReady(), /client disposed/);
	client.dispose();
	await Promise.all([first, second]);
	await assert.rejects(client.whenReady(), /client disposed/);
});

test('SSH cold package initialization can outlast ordinary request deadlines', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		transport.initializeDelayMs = 65_000;
		const client = new AppServerProtocolClient(transport, { initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS, requestTimeoutMs: 100 });
		using cleanup = toDisposable(() => client.dispose());
		const connected = client.connect();
		await flushHandlers();
		mock.timers.tick(65_000);
		await connected;
		assert.equal(client.state, 'ready');
		const request = assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}), /timed out/i);
		mock.timers.tick(100);
		await request;
		assert.equal(client.state, 'crashed');
	} finally { mock.timers.reset(); }
});

function largeFrame(transport: ProtocolTransport, value: Record<string, unknown>, byteLength?: number): AppServerFrame {
	const frame = JSON.stringify({ jsonrpc: '2.0', ...value }) + ' '.repeat(256 * 1024);
	const payload = new AppServerFrame(frame, byteLength ?? Buffer.byteLength(frame));
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, payload);
	return payload;
}

test('asynchronous responses preserve wire order, host cancellation and read consumption', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	let signal: AbortSignal | undefined;
	let finish!: (value: { targetId: string; }) => void;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		signal = context.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	transport.hostRequest('approval');
	await flushHandlers();
	const order: string[] = [];
	const pending = appServerRequest(client, 'session/list', {}).then(value => { order.push('response'); return value; });
	const payload = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	let consumed = false;
	void payload.consumed!.then(() => { consumed = true; });
	const cancel = JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'approval' } });
	const cancellation = new AppServerFrame(cancel, Buffer.byteLength(cancel));
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, cancellation);
	assert.equal(signal!.aborted, false);
	assert.equal(consumed, false);
	assert.equal(port.jobs.length, 1);
	await port.release();
	assert.deepEqual(await pending, { sessions: [] });
	await payload.consumed;
	await cancellation.consumed;
	assert.equal(consumed, true);
	assert.equal(signal!.aborted, true);
	finish({ targetId: 'late' });
	await flushHandlers();
	assert.deepEqual(transport.frames.filter(frame => frame.id === 'approval'), [{ jsonrpc: '2.0', id: 'approval', error: { code: -32800, message: 'Host request cancelled', data: null } }]);
	assert.deepEqual(order, ['response']);
	assert.equal(client.state, 'ready');
});

test('queued replies cannot match requests created after their receipt', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const first = appServerRequest(client, 'session/list', {});
	const id = transport.frames.at(-1)!.id as number;
	largeFrame(transport, { id, result: { sessions: [] } });
	transport.frame({ id: id + 1, result: { sessions: [] } });
	const second = assert.rejects(appServerRequest(client, 'session/list', {}), /unmatched response/);
	await port.release();
	assert.deepEqual(await first, { sessions: [] });
	await second;
	assert.equal(client.state, 'crashed');
});

test('host deadlines cancel work while EOF is waiting for Worker decoding without replying', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const port = new TestAppServerDecodePort();
		const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 100 }, new AppServerFrameDecoder(() => port));
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		let signal!: AbortSignal;
		let finish!: () => void;
		let effects = 0;
		using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], async (_params, context) => {
			signal = context.signal;
			await new Promise<void>(resolve => { finish = resolve; });
			if (!signal.aborted) { effects++; }
			return { targetId: 'late' };
		});
		transport.hostRequest('deadline');
		await flushHandlers();
		mock.timers.tick(50);
		const payload = largeFrame(transport, { method: '$/cancelRequest', params: { id: 'unrelated' } });
		transport.rejectFrameWrites = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'EOF' });
		mock.timers.tick(50);
		assert.equal(client.state, 'ready', 'EOF still waits for the received frame');
		assert.equal(signal.aborted, true, 'host deadline must cancel before decode finishes');
		finish();
		await flushHandlers();
		assert.equal(effects, 0);
		assert.equal(transport.frames.some(frame => frame.id === 'deadline'), false);
		await port.release();
		await payload.consumed;
		assert.equal(client.state, 'crashed');
	} finally { mock.timers.reset(); }
});

test('retirement settles queued consumption and cannot dispatch an old Worker reply into a replacement', async () => {
	const transport = new ProtocolTransport();
	const ports: TestAppServerDecodePort[] = [];
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => { const port = new TestAppServerDecodePort(); ports.push(port); return port; }));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const first = assert.rejects(appServerRequest(client, 'session/list', {}), /replaced/);
	const payload = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	const queued = largeFrame(transport, { method: '$/cancelRequest', params: { id: 'old' } });
	client.disconnect();
	await Promise.all([first, payload.consumed, queued.consumed]);
	assert.equal(ports[0].isDisposed, true);
	await client.connect();
	const next = appServerRequest(client, 'session/list', {});
	const replacement = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	await ports[0].release();
	assert.equal(client.state, 'ready');
	await ports[1].release();
	assert.deepEqual(await next, { sessions: [] });
	await replacement.consumed;
});

for (const limit of ['bytes', 'count'] as const) test(`asynchronous decode queue bounds ${limit} and fails without dropping waiters`, async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const rejected = assert.rejects(appServerRequest(client, 'session/list', {}), /queue capacity/);
	const payload = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } }, limit === 'bytes' ? 320 * 1024 * 1024 : undefined);
	for (let i = 0; i < (limit === 'count' ? 4096 : 1); i++) transport.frame({ method: '$/cancelRequest', params: { id: 'x' } });
	await rejected;
	await payload.consumed;
	assert.equal(port.isDisposed, true);
	assert.equal(client.state, 'crashed');
});

test('invalid large response schemas fail the connection and release read credit', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const rejected = assert.rejects(appServerRequest(client, 'session/list', {}));
	const payload = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: 'invalid' } });
	await port.release();
	await rejected;
	await payload.consumed;
	assert.equal(client.state, 'crashed');
});

for (const compatible of [false, true]) test(`large asynchronous initialize responses ${compatible ? 'release host calls after compatibility' : 'reject incompatibility before host effects'}`, async () => {
	const transport = new ProtocolTransport(() => {
		const result = createTestInitializeResult();
		return { ...result, serverInfo: { ...result.serverInfo, version: 'x'.repeat(256 * 1024) }, ...(!compatible ? { schemaHash: '0'.repeat(64) } : {}) };
	});
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	let calls = 0;
	let started!: () => void;
	const hostStarted = new Promise<void>(resolve => { started = resolve; });
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => { calls++; started(); return { targetId: 'browser' }; });
	transport.onInitialize = () => transport.hostRequest('during-initialize');
	const connected = client.connect();
	const settled = compatible ? connected : assert.rejects(connected, AppServerProtocolIncompatibleError);
	await flushHandlers();
	assert.equal(calls, 0);
	assert.equal(client.state, 'initializing');
	await port.release();
	await settled;
	if (compatible) await hostStarted;
	assert.equal(calls, compatible ? 1 : 0);
	assert.equal(client.state, compatible ? 'ready' : 'crashed');
});

test('request timeout during Worker decode terminates work and releases every queued frame', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const port = new TestAppServerDecodePort();
		const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 10 }, new AppServerFrameDecoder(() => port));
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		const rejected = assert.rejects(appServerRequest(client, 'session/list', {}), /timed out/);
		const first = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
		const queued = largeFrame(transport, { method: '$/cancelRequest', params: { id: 'x' } });
		mock.timers.tick(10);
		await Promise.all([rejected, first.consumed, queued.consumed]);
		assert.equal(port.isDisposed, true);
		assert.equal(client.state, 'crashed');
	} finally { mock.timers.reset(); }
});

test('peer closure waits for earlier responses while refusing new requests', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const first = appServerRequest(client, 'session/list', {});
	const payload = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	const second = assert.rejects(appServerRequest(client, 'session/list', {}), /peer exited/);
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'peer exited' });
	await assert.rejects(appServerRequest(client, 'session/list', {}), /closing/);
	await port.release();
	assert.deepEqual(await first, { sessions: [] });
	await second;
	await payload.consumed;
	assert.equal(client.state, 'crashed');
});

test('EOF drains notifications after cancellation without starting host effects or writing to the closed peer', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	let finishClose!: () => void;
	const closed = new Promise<void>(resolve => { finishClose = resolve; });
	using stateListener = client.onStateChange(state => { if (state === 'crashed') finishClose(); });
	let calls = 0;
	let signal: AbortSignal | undefined;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => { calls++; signal = context.signal; return new Promise(() => { }); });
	transport.hostRequest('existing');
	await flushHandlers();
	const notifications: unknown[] = [];
	using listener = client.onNotification(value => notifications.push(value));
	const pending = appServerRequest(client, 'session/list', {});
	largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	transport.frame({ method: '$/cancelRequest', params: { id: 'existing' } });
	transport.hostRequest('after-EOF');
	transport.frame({ method: 'session/deleted', params: { sessionId: 'delivered' } });
	transport.rejectFrameWrites = true;
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'peer EOF' });
	await port.release();
	assert.deepEqual(await pending, { sessions: [] });
	await flushHandlers();
	// Peer closure follows all received frames, including intervening task yields.
	await closed;
	assert.equal(calls, 1);
	assert.equal(signal!.aborted, true);
	assert.deepEqual(notifications, [{ method: 'session/deleted', params: { sessionId: 'delivered' } }]);
	assert.deepEqual(transport.frames.filter(frame => frame.id === 'existing' || frame.id === 'after-EOF'), []);
});

test('an unresponsive notification decode has a deadline without any pending client requests', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const port = new TestAppServerDecodePort();
		const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 10 }, new AppServerFrameDecoder(() => port));
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		const payload = largeFrame(transport, { method: '$/cancelRequest', params: { id: 'x' } });
		mock.timers.tick(10);
		await payload.consumed;
		assert.equal(port.isDisposed, true);
		assert.equal(client.state, 'crashed');
	} finally { mock.timers.reset(); }
});

test('transport-checked frames reuse wire length without re-encoding their JSON', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const pending = appServerRequest(client, 'session/list', {});
	const frame = JSON.stringify({ jsonrpc: '2.0', id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	const encode = mock.method(VSBuffer, 'fromString');
	try {
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, new AppServerFrame(frame, Buffer.byteLength(frame)));
		assert.deepEqual(await pending, { sessions: [] });
		assert.equal(encode.mock.calls.length, 0);
	} finally { encode.mock.restore(); }
});

test('plain frames cannot impersonate a transport-checked length', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const pending = appServerRequest(client, 'session/list', {});
	const frame = JSON.stringify({ jsonrpc: '2.0', id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame, byteLength: 320 * 1024 * 1024 + 1 });
	assert.deepEqual(await pending, { sessions: [] });
	assert.equal(client.state, 'ready');
});

test('transport-checked frames still validate the response schema', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const pending = appServerRequest(client, 'session/list', {});
	const rejected = assert.rejects(pending);
	const frame = JSON.stringify({ jsonrpc: '2.0', id: transport.frames.at(-1)!.id, result: { sessions: 'invalid' } });
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, new AppServerFrame(frame, Buffer.byteLength(frame)));
	await rejected;
	assert.equal(client.state, 'crashed');
});

test('connection recovery coalesces replacement, preserves the cause and reuses the protocol client', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const entries: LogEntry[] = [];
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, (message, error) => logger.error('app-server', message, error));
		const first = recovery.connect();
		assert.equal(recovery.connect(), first);
		await first;
		client.disconnect();
		mock.timers.tick(5000);
		assert.equal(opens, 1, 'intentional closure must not retry');
		await recovery.connect();
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Carrier exited with code 23' });
		assert.equal(client.state, 'crashed');
		mock.timers.tick(99);
		assert.equal(opens, 2);
		mock.timers.tick(1);
		await recovery.whenConnected();
		assert.equal(client.state, 'ready');
		assert.equal(opens, 3);
		assert.equal(client.generation, 3);
		assert.equal(entries.length, 1);
		assert.match((entries[0].error as Error).message, /Carrier exited with code 23/);
	} finally { mock.timers.reset(); }
});

test('connection recovery bounds failed acquisition attempts and a manual request can recover afterward', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const entries: LogEntry[] = [];
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		let opens = 0;
		let unavailable = false;
		const failure = new Error('port acquisition failed');
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			if (unavailable) { throw failure; }
			await client.connect();
		}, (message, error) => logger.error('app-server', message, error));
		await recovery.connect();
		unavailable = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'carrier lost' });
		for (const delay of [100, 500, 2000]) {
			mock.timers.tick(delay);
			await assert.rejects(recovery.whenConnected(), error => error === failure);
		}
		mock.timers.tick(10000);
		assert.equal(opens, 4);
		assert.equal(client.state, 'stopped');
		assert.equal(entries.filter(entry => entry.error === failure).length, 3);
		unavailable = false;
		await recovery.connect();
		assert.equal(client.state, 'ready');
		assert.equal(opens, 5);
	} finally { mock.timers.reset(); }
});

for (const offThread of [false, true]) test(`connection recovery stops after a ${offThread ? 'Worker' : 'synchronous'} model decode failure until manually retried`, async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const port = new TestAppServerDecodePort();
		const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(offThread ? () => port : undefined));
		using cleanup = toDisposable(() => { client.dispose(); port.dispose(); });
		let opens = 0;
		const errors: unknown[] = [];
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, (_message, error) => errors.push(error));
		await recovery.connect();
		const rejected = assert.rejects(appServerRequest(client, 'model/list', {}), /recommended_for\[2\]/);
		const model = createTestModel({ model: { provider: 'openai', model: 'example' }, display_name: 'Example' });
		const response = {
			id: transport.frames.at(-1)!.id,
			result: { models: [{ ...model, recommended_for: ['review', 'commit', 'unknownPurpose'] }] },
		};
		if (offThread) {
			largeFrame(transport, response);
			await port.release();
		} else {
			transport.frame(response);
		}
		await rejected;
		assert.equal(client.state, 'crashed');
		assert.equal(recovery.status, 'failed');
		assert.match(recovery.error!, /recommended_for\[2\]/);
		mock.timers.tick(100_000);
		recovery.suspend();
		recovery.resume();
		mock.timers.tick(100_000);
		assert.equal(opens, 1, 'neither timers nor OS wake can repair an invalid contract');
		assert.equal(recovery.status, 'failed');
		assert.equal(errors.length, 1);
		await recovery.reconnect();
		assert.equal(opens, 2);
		assert.equal(client.state, 'ready');
		assert.equal(recovery.status, 'idle');
		assert.equal(recovery.error, undefined);
	} finally { mock.timers.reset(); }
});

test('connection recovery stops when the replacement runtime has an incompatible schema', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let incompatible = false;
		const transport = new ProtocolTransport(() => ({ ...createTestInitializeResult(), ...(incompatible ? { schemaHash: `sha256:${'0'.repeat(64)}` } : {}) }));
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, () => { });
		await recovery.connect();
		incompatible = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'runtime replaced' });
		mock.timers.tick(100);
		await assert.rejects(recovery.whenConnected(), AppServerProtocolIncompatibleError);
		assert.equal(recovery.status, 'failed');
		mock.timers.tick(100_000);
		recovery.suspend();
		recovery.resume();
		mock.timers.tick(100_000);
		assert.equal(opens, 2);
		assert.equal(recovery.status, 'failed');
		incompatible = false;
		await recovery.reconnect();
		assert.equal(client.state, 'ready');
	} finally { mock.timers.reset(); }
});

test('connection recovery stops timers and releases its state listener on disposal', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const entries: LogEntry[] = [];
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, (message, error) => logger.error('app-server', message, error));
		await recovery.connect();
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'carrier lost' });
		recovery.dispose();
		mock.timers.tick(10000);
		assert.equal(opens, 1);
		await client.connect();
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'after disposal' });
		assert.equal(entries.length, 1, 'disposed recovery must release its state listener');
	} finally { mock.timers.reset(); }
});

test('connection recovery reports initial failure without starting background retries', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const client = new AppServerProtocolClient(new ProtocolTransport());
		using cleanup = toDisposable(() => client.dispose());
		using logger = new LogService({ sinks: [] });
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			throw new Error('initial acquisition failed');
		}, (message, error) => logger.error('app-server', message, error));
		await assert.rejects(recovery.connect(), /initial acquisition failed/);
		mock.timers.tick(10000);
		assert.equal(opens, 1);
	} finally { mock.timers.reset(); }
});

test('closing a connection withdraws its negotiated capabilities before observers run', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	assert.equal(client.capabilities?.sessions, true);
	let observed: unknown = 'not called';
	using observer = client.onStateChange(state => { if (state === 'stopped') { observed = client.capabilities; } });
	client.disconnect();
	assert.equal(observed, undefined);
	assert.equal(client.capabilities, undefined);
	assert.deepEqual(client.slashCommands, []);
});

test('unexpected closure delivers its cause to recovery observers while deliberate disconnect has no failure', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const failures: { state: string; error: Error; }[] = [];
	using observer = client.onStateChange((state, error) => { if (error) failures.push({ state, error }); });
	await client.connect();
	client.disconnect();
	assert.equal(failures.length, 0);
	await client.connect();
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Carrier exited with code 23' });
	assert.equal(client.state, 'crashed');
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.state, 'crashed');
	assert.match(failures[0]!.error.message, /Carrier exited with code 23/);
});

test('a retired host result is discarded before decoding and cannot crash its replacement', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let finish!: (value: { targetId: string; }) => void;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => new Promise(resolve => { finish = resolve; }));
	await client.connect();
	transport.hostRequest('retired');
	await flushHandlers();
	client.disconnect();
	await client.connect();
	finish({ targetId: 42 } as unknown as { targetId: string; });
	await flushHandlers();
	assert.equal(client.state, 'ready');
	assert.equal(transport.frames.some(frame => frame.id === 'retired'), false);
});

test('cancelling a queued host request prevents the handler from starting and replies once', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let calls = 0;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => {
		calls++;
		return { targetId: 'target' };
	});
	await client.connect();
	transport.hostRequest('cancel-before-start');
	transport.frame({ method: '$/cancelRequest', params: { id: 'cancel-before-start' } });
	await flushHandlers();
	assert.equal(calls, 0);
	assert.deepEqual(transport.frames.filter(frame => frame.id === 'cancel-before-start'), [{ jsonrpc: '2.0', id: 'cancel-before-start', error: { code: -32800, message: 'Host request cancelled', data: null } }]);
});

test('recovery observers acquire a replacement only after the old carrier is released', async () => {
	const transport = new ProtocolTransport();
	transport.shouldCloseSynchronously = true;
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	let replacement: Promise<unknown> | undefined;
	using observer = client.onStateChange(state => { if (state === 'crashed') { replacement = client.connect(); } });
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'remote closed' });
	assert.ok(replacement);
	await replacement;
	assert.equal(client.state, 'ready');
	assert.equal(client.generation, 2);
});

test('unserializable requests reject asynchronously and release their pending capacity', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	for (let attempt = 0; attempt < 128; attempt++) {
		await assert.rejects(() => appServerRequest(client, 'session/list', { invalid: 1n } as {}), /BigInt/);
	}
	const pending = client.request(APP_SERVER_METHODS['session/list'], {});
	transport.frame({ id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	assert.deepEqual(await pending, { sessions: [] });
	assert.equal(client.state, 'ready');
});

test('same request IDs on separate clients complete only their own pending method', async () => {
	const leftTransport = new ProtocolTransport();
	const rightTransport = new ProtocolTransport();
	const left = new AppServerProtocolClient(leftTransport);
	const right = new AppServerProtocolClient(rightTransport);
	using cleanup = toDisposable(() => { left.dispose(); right.dispose(); });
	await Promise.all([left.connect(), right.connect()]);
	const leftPending = appServerRequest(left, 'session/list', {});
	const rightPending = appServerRequest(right, 'automation/list', {});
	const id = leftTransport.frames.at(-1)!.id;
	assert.equal(id, rightTransport.frames.at(-1)!.id);
	const leftRejected = assert.rejects(leftPending);
	leftTransport.frame({ id, result: { automations: [] } });
	await leftRejected;
	assert.equal(left.state, 'crashed');
	assert.equal(right.state, 'ready');
	rightTransport.frame({ id, result: { automations: [] } });
	assert.deepEqual(await rightPending, { automations: [] });
});

test('pending responses may complete out of order using each request method decoder', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const sessions = appServerRequest(client, 'session/list', {});
	const sessionsId = transport.frames.at(-1)!.id;
	const automations = appServerRequest(client, 'automation/list', {});
	transport.frame({ id: transport.frames.at(-1)!.id, result: { automations: [] } });
	transport.frame({ id: sessionsId, result: { sessions: [] } });
	assert.deepEqual(await sessions, { sessions: [] });
	assert.deepEqual(await automations, { automations: [] });
});

for (const duplicate of [false, true]) {
	test(`${duplicate ? 'duplicate' : 'unknown'} current response IDs fail only the current connection`, async () => {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		let id: unknown = 999;
		if (duplicate) {
			const pending = appServerRequest(client, 'session/list', {});
			id = transport.frames.at(-1)!.id;
			transport.frame({ id, result: { sessions: [] } });
			await pending;
		}
		transport.frame({ id, result: { sessions: [] } });
		assert.equal(client.state, 'crashed');
	});
}

test('late responses from a retired generation do not complete a new pending request', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const old = appServerRequest(client, 'session/list', {});
	const oldId = transport.frames.at(-1)!.id;
	const oldRejected = assert.rejects(old, /replaced/);
	client.disconnect();
	await oldRejected;
	await client.connect();
	const current = appServerRequest(client, 'automation/list', {});
	const currentId = transport.frames.at(-1)!.id;
	transport.frame({ id: oldId, result: { invalidOldResult: true } });
	assert.equal(client.state, 'ready');
	transport.frame({ id: currentId, result: { automations: [] } });
	assert.deepEqual(await current, { automations: [] });
});

test('a cancelled host ID can be reused without accepting the retired handler result', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const completions: ((value: { targetId: string; }) => void)[] = [];
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => new Promise(resolve => { completions.push(resolve); }));
	await client.connect();
	transport.hostRequest('reused');
	await flushHandlers();
	transport.frame({ method: '$/cancelRequest', params: { id: 'reused' } });
	transport.hostRequest('reused');
	await flushHandlers();
	completions[0]({ targetId: 42 } as unknown as { targetId: string; });
	completions[1]({ targetId: 'new-target' });
	await flushHandlers();
	assert.deepEqual(transport.frames.filter(frame => frame.id === 'reused'), [
		{ jsonrpc: '2.0', id: 'reused', error: { code: -32800, message: 'Host request cancelled', data: null } },
		{ jsonrpc: '2.0', id: 'reused', result: { targetId: 'new-target' } },
	]);
	assert.equal(client.state, 'ready');
});

test('an abort listener reconnecting the client cannot send its cancellation to the replacement', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let replacement: Promise<unknown> | undefined;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		context.signal.addEventListener('abort', () => { client.disconnect(); replacement = client.connect(); }, { once: true });
		return new Promise(() => { });
	});
	await client.connect();
	transport.hostRequest('old-cancel');
	await flushHandlers();
	transport.frame({ method: '$/cancelRequest', params: { id: 'old-cancel' } });
	assert.ok(replacement);
	await replacement;
	assert.equal(client.state, 'ready');
	assert.equal(transport.frames.some(frame => frame.id === 'old-cancel'), false);
});

test('timed out host work is aborted and produces exactly one terminal reply', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 10 });
	using cleanup = toDisposable(() => client.dispose());
	let finish!: (value: { targetId: string; }) => void;
	let cancelled!: () => void;
	const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		context.signal.addEventListener('abort', cancelled, { once: true });
		return new Promise(resolve => { finish = resolve; });
	});
	await client.connect();
	transport.hostRequest('timed-out');
	await cancellation;
	finish({ targetId: 42 } as unknown as { targetId: string; });
	await flushHandlers();
	assert.deepEqual(transport.frames.filter(frame => frame.id === 'timed-out'), [{ jsonrpc: '2.0', id: 'timed-out', error: { code: -32000, message: 'Host request timed out', data: null } }]);
	assert.equal(client.state, 'ready');
});

for (const compatible of [false, true]) {
	test(`host calls buffered behind initialization ${compatible ? 'run after compatibility' : 'are dropped on incompatibility'}`, async () => {
		const transport = new ProtocolTransport(() => {
			const initialized = createTestInitializeResult();
			if (!compatible) { initialized.capabilities.turns = false; }
			return initialized;
		});
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let stateDuringHandler: string | undefined;
		using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => { stateDuringHandler = client.state; return { targetId: 'target' }; });
		transport.onInitialize = () => transport.hostRequest('during-initialize');
		if (compatible) { await client.connect(); } else { await assert.rejects(client.connect(), /turns/); }
		await flushHandlers();
		assert.equal(stateDuringHandler, compatible ? 'ready' : undefined);
		assert.equal(client.state, compatible ? 'ready' : 'crashed');
		assert.equal(transport.frames.filter(frame => frame.id === 'during-initialize').length, compatible ? 1 : 0);
	});
}

test('initialization buffering is bounded and rejects the handshake without starting host work', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let calls = 0;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => {
		calls++;
		return { targetId: 'target' };
	});
	transport.onInitialize = () => { for (let index = 0; index < 129; index++) { transport.hostRequest(`queued-${index}`); } };
	await assert.rejects(client.connect());
	await flushHandlers();
	assert.equal(calls, 0);
	assert.equal(client.state, 'crashed');
});


test('terminal transport closure retains its diagnostic while withdrawing the handshake', async () => {
	const message = 'authorization revoked: open another authenticated link';
	const transport = new ProtocolTransport(() => {
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message });
		return createTestInitializeResult();
	});
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await assert.rejects(client.connect(), (error: unknown) => error instanceof Error && error.message === message);
	assert.equal(client.state, 'stopped');
	assert.equal(client.capabilities, undefined);
});


test('an abort listener cannot acquire a new pending request while shutdown retires its connection', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let reentrant: Promise<string> | undefined;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		context.signal.addEventListener('abort', () => {
			reentrant = appServerRequest(client, 'session/list', {}).then(() => 'fulfilled', () => 'rejected');
		}, { once: true });
		return new Promise(() => { });
	});
	await client.connect();
	transport.hostRequest('closing');
	await flushHandlers();
	client.disconnect();
	assert.ok(reentrant);
	assert.equal(transport.frames.some(frame => frame.method === 'session/list'), false);
	assert.equal(await reentrant, 'rejected');
	assert.equal(client.state, 'stopped');
});


test('frames emitted by a releasing carrier cannot start host work during shutdown', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	let calls = 0;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => {
		calls++;
		return { targetId: 'target' };
	});
	await client.connect();
	transport.onDisconnect = () => transport.hostRequest('during-release');
	client.disconnect();
	await flushHandlers();
	assert.equal(calls, 0);
	assert.equal(transport.frames.some(frame => frame.id === 'during-release'), false);
	assert.equal(client.state, 'stopped');
});


test('directory grant hosts declare the canonical capability during initialization', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport, { capabilities: { directoryGrantsHost: { version: 1 } } });
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const initialized = transport.frames.find(frame => frame.method === 'initialize')?.params as { capabilities: Record<string, unknown>; };
	assert.deepEqual(initialized.capabilities.directoryGrantsHost, { version: 1 });
	assert.equal(initialized.capabilities.dirPermissionsHost, undefined);
});

test('directory grant clients reject a different schema before sending domain requests', async () => {
	const transport = new ProtocolTransport(() => ({ ...createTestInitializeResult(), schemaHash: '0'.repeat(64) }));
	const client = new AppServerProtocolClient(transport, { capabilities: { directoryGrantsHost: { version: 1 } } });
	using cleanup = toDisposable(() => client.dispose());
	await assert.rejects(client.connect(), error => error instanceof AppServerProtocolIncompatibleError && error.incompatibility.kind === 'schemaHash');
	assert.notEqual(client.state, 'ready');
	assert.ok(transport.frames.every(frame => frame.method === 'initialize'));
});


test('recovery publishes exhaustion once, retries manually and never replays an uncertain mutation', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let fail = false;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			client.disconnect();
			if (fail) throw new Error('synthetic offline');
			await client.connect();
		}, () => { });
		const states: string[] = [];
		using listener = recovery.onDidChange(() => states.push(recovery.status));
		await recovery.connect();
		const write = assert.rejects(appServerRequest(client, 'session/request', { commandId: 'uncertain', sessionId: '00000000-0000-4000-8000-000000000001', request: { type: 'archive' } }), /lost/);
		fail = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		await write;
		for (const delay of [100, 500, 2000]) {
			mock.timers.tick(delay);
			await assert.rejects(recovery.whenConnected(), /synthetic offline/);
		}
		assert.equal(recovery.status, 'failed');
		assert.equal(recovery.error, 'synthetic offline');
		mock.timers.tick(100_000);
		assert.equal(states.filter(state => state === 'failed').length, 1);
		fail = false;
		const manual = recovery.reconnect();
		assert.equal(recovery.reconnect(), manual);
		await manual;
		assert.equal(recovery.status, 'idle');
		assert.equal(recovery.error, undefined);
		assert.equal(transport.frames.filter(frame => frame.method === 'session/request').length, 1);
	} finally { mock.timers.reset(); }
});

test('OS sleep pauses retries and wake restores an exhausted connection without replacing a healthy lease', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let fail = false;
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			if (fail) throw new Error('offline after wake');
			await client.connect();
		}, () => { });
		await recovery.connect();
		recovery.suspend();
		recovery.resume();
		assert.equal(opens, 1);
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		recovery.suspend();
		mock.timers.tick(3_600_000);
		assert.equal(opens, 1);
		assert.equal(recovery.status, 'suspended');
		fail = true;
		recovery.resume();
		await assert.rejects(recovery.whenConnected(), /offline after wake/);
		for (const delay of [100, 500, 2000]) {
			mock.timers.tick(delay);
			await assert.rejects(recovery.whenConnected(), /offline after wake/);
		}
		assert.equal(recovery.status, 'failed');
		recovery.suspend();
		fail = false;
		recovery.resume();
		await recovery.whenConnected();
		assert.equal(recovery.status, 'idle');
		assert.equal(client.state, 'ready');
		recovery.suspend();
		recovery.dispose();
		recovery.resume();
		mock.timers.tick(10_000);
		assert.equal(opens, 6);
	} finally { mock.timers.reset(); }
});

test('authorization withdrawal during a recovery attempt is terminal across OS wake', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let revoked = false;
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			const connecting = client.connect();
			if (revoked) transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Authorization revoked' });
			await connecting;
		}, () => { });
		await recovery.connect();
		revoked = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		mock.timers.tick(100);
		await assert.rejects(recovery.whenConnected(), /Authorization revoked/);
		assert.equal(recovery.status, 'unavailable');
		recovery.suspend();
		recovery.resume();
		mock.timers.tick(1_000_000);
		assert.equal(opens, 2);
		assert.equal(recovery.status, 'unavailable');
	} finally { mock.timers.reset(); }
});

test('a recovery observer can retry synchronously without leaving a second timer', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, () => { });
		await recovery.connect();
		using listener = recovery.onDidChange(() => {
			if (recovery.status === 'recovering') void recovery.reconnect();
		});
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		await recovery.whenConnected();
		mock.timers.tick(10_000);
		assert.equal(opens, 2);
	} finally { mock.timers.reset(); }
});


test('Web recovery retains its elapsed budget across attempts and excludes reported OS sleep', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let offline = false;
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			if (offline) throw new Error('Web offline');
			await client.connect();
		}, () => { }, {
			autoRestore: true,
			initialDelayMs: 500,
			maxDelayMs: 500,
			maxAttempts: Number.POSITIVE_INFINITY,
			maxElapsedTimeMs: 1_200,
		});
		await recovery.connect();
		offline = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		mock.timers.tick(500);
		await assert.rejects(recovery.whenConnected(), /Web offline/);
		mock.timers.tick(500);
		await assert.rejects(recovery.whenConnected(), /Web offline/);
		assert.equal(opens, 3);
		recovery.suspend();
		mock.timers.tick(3_600_000);
		recovery.resume();
		await assert.rejects(recovery.whenConnected(), /Web offline/);
		mock.timers.tick(199);
		assert.equal(recovery.status, 'recovering');
		mock.timers.tick(1);
		assert.equal(recovery.status, 'failed');
		assert.match(recovery.error!, /timed out after 1200 ms/);
		assert.equal(opens, 4);
		offline = false;
		recovery.suspend();
		recovery.resume();
		await recovery.whenConnected();
		assert.equal(recovery.status, 'idle');
	} finally { mock.timers.reset(); }
});

for (const completes of [true, false]) {
	test(`manual Web reconnect ${completes ? 'can finish after the previous recovery deadline' : 'times out at its new recovery deadline'}`, async () => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
		try {
			const budget = 1_200;
			const initialDelay = 500;
			const transport = new ProtocolTransport();
			const client = new AppServerProtocolClient(transport);
			using cleanup = toDisposable(() => client.dispose());
			let offline = false;
			using recovery = new AppServerConnectionRecovery(client, async () => {
				client.disconnect();
				if (offline) {
					throw new Error('Web offline');
				}
				await client.connect();
			}, () => { }, {
				autoRestore: true,
				initialDelayMs: initialDelay,
				maxDelayMs: 1_000,
				maxAttempts: Number.POSITIVE_INFINITY,
				maxElapsedTimeMs: budget,
			});
			await recovery.connect();
			offline = true;
			transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
			mock.timers.tick(initialDelay);
			await assert.rejects(recovery.whenConnected(), /Web offline/);
			mock.timers.tick(budget - initialDelay - 1);
			assert.equal(recovery.status, 'recovering');

			offline = false;
			transport.holdInitialize = true;
			const manual = recovery.reconnect();
			await flushHandlers();
			const initialize = transport.frames.at(-1)!;
			assert.equal(initialize.method, 'initialize');
			assert.equal(client.state, 'initializing');

			mock.timers.tick(1);
			assert.equal(recovery.status, 'recovering');
			assert.equal(client.state, 'initializing');
			if (completes) {
				transport.frame({ id: initialize.id, result: createTestInitializeResult() });
				await manual;
				assert.equal(client.state, 'ready');
				assert.equal(recovery.status, 'idle');
				return;
			}

			mock.timers.tick(budget - 2);
			assert.equal(recovery.status, 'recovering');
			assert.equal(client.state, 'initializing');
			mock.timers.tick(1);
			assert.equal(recovery.status, 'failed');
			assert.equal(client.state, 'stopped');
			await assert.rejects(manual, /timed out after 1200 ms/);
		} finally { mock.timers.reset(); }
	});
}

test('the recovery deadline retires an in-flight handshake and ignores its late reply', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		using recovery = new AppServerConnectionRecovery(client, async () => {
			client.disconnect();
			await client.connect();
		}, () => { }, { autoRestore: true, initialDelayMs: 5, maxDelayMs: 5, maxAttempts: 3, maxElapsedTimeMs: 30 });
		await recovery.connect();
		transport.holdInitialize = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		mock.timers.tick(5);
		await Promise.resolve();
		await Promise.resolve();
		const initialize = transport.frames.at(-1)!;
		assert.equal(initialize.method, 'initialize');
		assert.equal(client.state, 'initializing');
		const timedOut = assert.rejects(recovery.whenConnected(), /timed out after 30 ms/);
		mock.timers.tick(10);
		recovery.suspend();
		mock.timers.tick(500);
		assert.equal(recovery.status, 'suspended');
		assert.equal(client.state, 'initializing');
		recovery.resume();
		mock.timers.tick(14);
		assert.equal(recovery.status, 'recovering');
		mock.timers.tick(1);
		await timedOut;
		assert.equal(recovery.status, 'failed');
		assert.equal(client.state, 'stopped');
		transport.frame({ id: initialize.id, result: createTestInitializeResult() });
		assert.equal(client.state, 'stopped');
		transport.holdInitialize = false;
		await recovery.reconnect();
		assert.equal(recovery.status, 'idle');
	} finally { mock.timers.reset(); }
});

test('recovery uses capped exponential delays and resets the attempt limit after manual recovery', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let offline = false;
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			if (offline) {
				throw new Error('offline');
			}
			await client.connect();
		}, () => { }, {
			autoRestore: true,
			initialDelayMs: 500,
			maxDelayMs: 1_500,
			maxAttempts: 3,
		});
		await recovery.connect();
		offline = true;
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		for (const [index, delay] of [500, 1_000, 1_500].entries()) {
			mock.timers.tick(delay - 1);
			assert.equal(opens, index + 1);
			mock.timers.tick(1);
			await assert.rejects(recovery.whenConnected(), /offline/);
		}
		assert.equal(recovery.status, 'failed');
		mock.timers.tick(60_000);
		assert.equal(opens, 4);
		offline = false;
		await recovery.reconnect();
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost again' });
		mock.timers.tick(499);
		assert.equal(opens, 5);
		mock.timers.tick(1);
		await recovery.whenConnected();
		assert.equal(opens, 6);
		assert.equal(recovery.status, 'idle');
	} finally { mock.timers.reset(); }
});

test('a policy disabling automatic restore still allows explicit reconnect', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		let opens = 0;
		using recovery = new AppServerConnectionRecovery(client, async () => {
			opens++;
			client.disconnect();
			await client.connect();
		}, () => { }, {
			autoRestore: false,
			initialDelayMs: 500,
			maxDelayMs: 1_500,
			maxAttempts: 3,
		});
		await recovery.connect();
		transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'lost' });
		assert.equal(recovery.status, 'failed');
		mock.timers.tick(60_000);
		assert.equal(opens, 1);
		recovery.suspend();
		mock.timers.tick(60_000);
		recovery.resume();
		await recovery.whenConnected();
		assert.equal(opens, 1, 'OS wake must keep waiting for explicit connection intent');
		assert.equal(recovery.status, 'failed');
		await recovery.reconnect();
		assert.equal(opens, 2);
		assert.equal(client.state, 'ready');
		assert.equal(recovery.status, 'idle');
	} finally { mock.timers.reset(); }
});


test('canceled reads retire large payloads while preserving remote lifetime and ordered carrier consumption', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const controller = new AbortController();
	const canceledRead = assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}, { signal: controller.signal }), CancellationError);
	const canceledId = transport.frames.at(-1)!.id;
	controller.abort();
	// An out-of-order live response still validates and reaches its consumer.
	const live = appServerRequest(client, 'session/list', {});
	transport.frame({ id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	assert.deepEqual(await live, { sessions: [] });
	// The canceled payload is deliberately schema-invalid: only its envelope is needed.
	const late = largeFrame(transport, { id: canceledId, result: { unused: 'x'.repeat(300_000) } });
	const ordered = appServerRequest(client, 'session/list', {});
	const order: string[] = [];
	void late.consumed!.then(() => order.push('late consumed'));
	transport.frame({ id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	await port.release();
	await late.consumed;
	await canceledRead;
	assert.deepEqual(await ordered, { sessions: [] });
	assert.deepEqual(order, ['late consumed']);
	assert.equal(client.state, 'ready');
	// A duplicate is not an indefinitely accepted tombstone.
	transport.frame({ id: canceledId, result: {} });
	assert.equal(client.state, 'crashed');
});

test('canceling a read already queued in the Worker cannot publish its late validated result', async () => {
	const transport = new ProtocolTransport();
	const port = new TestAppServerDecodePort();
	const client = new AppServerProtocolClient(transport, {}, new AppServerFrameDecoder(() => port));
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const controller = new AbortController();
	const result = assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}, { signal: controller.signal }), CancellationError);
	const frame = largeFrame(transport, { id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	controller.abort();
	await port.release();
	await result;
	await frame.consumed;
	assert.equal(client.state, 'ready');
});

test('canceled routing slots keep the existing request bound and deadline rather than growing tombstones', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const transport = new ProtocolTransport();
		const client = new AppServerProtocolClient(transport, { requestTimeoutMs: 100 });
		using cleanup = toDisposable(() => client.dispose());
		await client.connect();
		const canceledReads: Promise<void>[] = [];
		for (let i = 0; i < 128; i++) {
			const controller = new AbortController();
			const rejected = assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}, { signal: controller.signal }), /timed out/);
			canceledReads.push(rejected);
			controller.abort();
		}
		await assert.rejects(appServerRequest(client, 'session/list', {}), /request limit/);
		mock.timers.tick(100);
		await Promise.all(canceledReads);
		assert.equal(client.state, 'crashed');
		await client.connect();
		const read = appServerRequest(client, 'session/list', {});
		// The old generation remains harmless after all cancellation slots are released.
		transport.frame({ id: 2, result: {} });
		transport.frame({ id: transport.frames.at(-1)!.id, result: { sessions: [] } });
		assert.deepEqual(await read, { sessions: [] });
		assert.equal(client.state, 'ready');
	} finally { mock.timers.reset(); }
});

test('aborted input sends no request and completion removes its abort listener before later cancellation', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}, { signal: controller.signal }), CancellationError);
	assert.equal(transport.frames.length, 1);
	const completed = new AbortController();
	const result = client.request(APP_SERVER_METHODS['session/list'], {}, { signal: completed.signal });
	assert.equal(getEventListeners(completed.signal, 'abort').length, 1);
	transport.frame({ id: transport.frames.at(-1)!.id, result: { sessions: [] } });
	assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
	completed.abort();
	assert.deepEqual(await result, { sessions: [] });
	assert.equal(client.state, 'ready');
});

test('GitHub read cancellation keeps refresh coalescing until remote retirement and skips the unused result', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	using source = new CancellationTokenSource();
	await client.connect();
	const service = new AppServerGitHubService(client);
	let settled = false;
	const read = assert.rejects(service.listAccounts(source.token), CancellationError).then(() => { settled = true; });
	const original = transport.frames.at(-1)!;
	source.cancel();
	await flushHandlers();
	assert.equal(settled, false);
	assert.equal(transport.frames.at(-1)!.method, 'github/cancel');
	assert.deepEqual(transport.frames.at(-1)!.params, { operationId: (original.params as { operationId: string; }).operationId });
	transport.frame({ id: transport.frames.at(-1)!.id, result: { status: 'requested' } });
	transport.frame({ id: original.id, result: { noLongerNeeded: 'large canceled graph' } });
	await read;
	assert.equal(client.state, 'ready');
});

test('GitHub write cancellation preserves the original committed outcome and never replays the write', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	using source = new CancellationTokenSource();
	await client.connect();
	const service = new AppServerGitHubService(client);
	let settled = false;
	const write = service.markNotificationRead('account', 'notification', source.token).then(() => { settled = true; });
	const original = transport.frames.at(-1)!;
	source.cancel();
	await flushHandlers();
	assert.equal(settled, false);
	transport.frame({ id: transport.frames.at(-1)!.id, result: { status: 'requested' } });
	transport.frame({ id: original.id, result: null });
	await write;
	assert.equal(settled, true);
	assert.equal(transport.frames.filter(frame => frame.method === 'github/notifications/read').length, 1);
	assert.equal(client.state, 'ready');
});

test('GitHub CI operations use generated contracts, selected grants and immutable check targets', async () => {
	const transport = new ProtocolTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const service = new AppServerGitHubService(client);
	const repository = { accountId: 'selected-grant', host: 'ghe.example', owner: 'team', name: 'repo' };
	const target = { number: 7, commit: 'a'.repeat(40), checkId: 9 };
	const reading = service.readCheckDetails(repository, target, 2);
	const request = transport.frames.at(-1)!;
	assert.equal(request.method, 'github/check/details');
	assert.deepEqual(request.params, { operationId: (request.params as { operationId: string; }).operationId, accountId: 'selected-grant', repository: { host: 'ghe.example', owner: 'team', name: 'repo' }, ...target, page: 2 });
	const details = { title: 'Failure', summary: 'Build failed', text: 'Output', annotations: [{ path: 'src/main.rs', startLine: 3, endLine: 4, annotationLevel: 'failure', message: 'Error', title: null }], nextPage: null, actionsJob: true };
	transport.frame({ id: request.id, result: details });
	assert.deepEqual(await reading, details);
	using canceled = new CancellationTokenSource();
	const log = assert.rejects(service.readCheckLog(repository, target, canceled.token), CancellationError);
	const original = transport.frames.at(-1)!;
	assert.equal(original.method, 'github/check/log');
	canceled.cancel();
	await flushHandlers();
	assert.equal(transport.frames.at(-1)!.method, 'github/cancel');
	transport.frame({ id: transport.frames.at(-1)!.id, result: { status: 'requested' } });
	transport.frame({ id: original.id, result: { url: 'https://productionresults.blob.core.windows.net/private' } });
	await log;
	using rerunCancellation = new CancellationTokenSource();
	const rerun = service.rerunCheck(repository, target, rerunCancellation.token);
	const mutation = transport.frames.at(-1)!;
	assert.equal(mutation.method, 'github/check/rerun');
	rerunCancellation.cancel();
	await flushHandlers();
	transport.frame({ id: transport.frames.at(-1)!.id, result: { status: 'requested' } });
	transport.frame({ id: mutation.id, result: null });
	await rerun;
	assert.equal(transport.frames.filter(frame => frame.method === 'github/check/rerun').length, 1);
	assert.equal(client.state, 'ready');
});

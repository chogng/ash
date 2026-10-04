import { createTestInitializeResult } from '../common/testAppServerProtocol.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { isCancellationError } from "../../../../base/common/errors.js";
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from "../../../../base/common/types.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, APP_SERVER_CAPABILITY_VERSION, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH, type InitializeResult, type ServerNotification } from "../../common/generated/index.js";
import { connectWebRendererApi } from "../../../../platform/app-server/browser/webRendererApi.js";
import { WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from "../../common/appServerTransport.js";
import { AppServerProtocolClient } from "../../../../platform/app-server/browser/appServerProtocolClient.js";
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';

test('Git ignore cancellation reaches the server and consumes the original terminal response', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.git.checkIgnore({ repositoryId: 'root', paths: ['cache'] }, cancellation.token);
	const originalIndex = transport.requests.length - 1;
	const original = transport.requests[originalIndex]!;
	const rejected = assert.rejects(pending, isCancellationError);
	cancellation.cancel();
	const cancelIndex = transport.requests.length - 1;
	assert.equal(transport.requests[cancelIndex]!.method, 'git/checkIgnore/cancel');
	assert.deepEqual(transport.requests[cancelIndex]!.params, { operationId: (original.params as { operationId: string }).operationId });
	transport.respondAt(cancelIndex, { status: 'requested' });
	transport.rejectAt(originalIndex, { code: -32800, message: 'RequestCancelled', data: { kind: 'RequestCancelled' } });
	await rejected;
	const count = transport.requests.length;
	await assert.rejects(connected.api.git.checkIgnore({ paths: ['cache'] }, cancellation.token), isCancellationError);
	assert.equal(transport.requests.length, count);
});

test('Git ignore preserves the server result when completion wins the cancellation race', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.git.checkIgnore({ paths: ['cache'] }, cancellation.token);
	const queryIndex = transport.requests.length - 1;
	cancellation.cancel();
	transport.respondAt(-1, { status: 'completed' });
	transport.respondAt(queryIndex, { ignoredPaths: ['cache'] });
	assert.deepEqual(await pending, { ignoredPaths: ['cache'] });
});

const connectorHostServices = {
	externalOpener: { openExternal: async () => true },
	clipboardService: { readText: async () => '', writeText: async () => undefined, readResources: async () => ({ resources: [], operation: 'copy' as const }), writeResources: async () => undefined, hasResources: async () => false },
};

test('Web reconnect initializes again without replaying an uncertain write', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	try {
		const pending = connected.api.fs.writeFile({ dirId: 'web-dev:test', path: 'main.ts', content: 'changed' });
		const rejected = assert.rejects(pending, /backend restarted/);
		transport.close('backend restarted');
		await rejected;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Web did not reconnect')), 3_000);
			const subscription = connected.api.appServer.onConnectionState(state => {
				if (state === 'ready') { clearTimeout(timeout); subscription.dispose(); resolve(); }
			});
		});
		assert.equal(transport.requests.filter(request => request.method === 'initialize').length, 2);
		assert.equal(transport.requests.filter(request => request.method === 'fs/writeFile').length, 1);
		assert.deepEqual(await connected.api.session.list(), { sessions: [] });
	} finally { connected.dispose(); }
});

test('Web disposal cancels scheduled reconnect and revoked authorization is terminal', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	transport.close('connection lost');
	connected.dispose();
	await new Promise(resolve => setTimeout(resolve, 600));
	assert.equal(transport.sentEvents.filter(event => event === WEB_APP_SERVER_CONNECT_EVENT).length, 1);
	const revokedTransport = new FakeTransport();
	const revoked = await connectWebRendererApi(revokedTransport, connectorHostServices);
	try {
		revokedTransport.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Authorization revoked' });
		await new Promise(resolve => setTimeout(resolve, 600));
		assert.equal(await revoked.api.appServer.getConnectionState(), 'stopped');
		assert.equal(revokedTransport.sentEvents.filter(event => event === WEB_APP_SERVER_CONNECT_EVENT).length, 1);
	} finally { revoked.dispose(); }
});

test('Hooks use the shared protocol, retain disabled declarations, and refresh on configuration changes', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const pending = connected.api.hooks.read('session-hooks');
	assert.deepEqual(transport.requests.at(-1)?.params, { sessionId: 'session-hooks' });
	assert.equal(transport.requests.at(-1)?.method, 'hook/list');
	transport.respondAt(-1, { sources: [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [
		{ id: 'user:hook:check', event: 'preToolUse', enablement: 'disabled', matcher: { toolNames: ['shell-command'] }, action: { type: 'process', program: '/program with spaces', args: ['two words', '"quote"'] } },
	] }] });
	assert.deepEqual(await pending, [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [
		{ id: 'user:hook:check', event: 'preToolUse', enabled: false, toolNames: ['shell-command'], program: '/program with spaces', args: ['two words', '"quote"'] },
	] }]);
	const userRead = connected.api.hooks.read();
	assert.deepEqual(transport.requests.at(-1)?.params, {});
	transport.respondAt(-1, { sources: [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [] }] });
	assert.equal((await userRead)[0]?.hooks.length, 0);
	let changes = 0;
	const subscription = connected.api.hooks.onDidChange(() => changes++);
	transport.emitNotification({ method: 'config/changed', params: { revision: 2, generation: 2 } });
	assert.equal(changes, 1);
	subscription.dispose();
	transport.emitNotification({ method: 'config/changed', params: { revision: 3, generation: 3 } });
	assert.equal(changes, 1);
	assert.equal(connected.api.hooks.userConfigurationEditor, undefined);
});

test('review environment adapter preserves scope, provenance, cancellation, and revision conflicts', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const environment = connected.api.approvalEnvironment;
	assert.ok(environment);
	const scope = { type: 'thread' as const, threadId: 'own-thread' };
	const entry = { id: 'entry-1', kind: 'fact' as const, title: 'Build', content: 'pnpm build', source: { id: 'source-1', kind: 'projectFile' as const, label: 'package.json', revision: 'sha256-version' }, accepted: false, current: true };
	const defaults = { recentCommands: false, shellHistory: false, otherRepositories: false, summarizeWithModel: false, history: { sessions: 50, commandsPerSession: 200, days: null } };
	const read = environment.read(scope);
	assert.deepEqual(transport.requests.at(-1)?.params, { scope });
	transport.respondAt(-1, { root: '/own-worktree', scanOptions: defaults, profile: { revision: 3, entries: [entry], observations: [] } });
	assert.deepEqual(await read, { root: '/own-worktree', scanOptions: defaults, revision: 3, entries: [entry] });
	const options = { ...defaults, summarizeWithModel: true };
	const model = { provider: 'openai', model: 'task-model' };
	const scan = environment.scan(scope, 'scan-id', options, model);
	assert.equal(transport.requests.at(-1)?.method, 'approval/environment/scan');
	assert.deepEqual(transport.requests.at(-1)?.params, { scope, operationId: 'scan-id', options, model });
	const historical = { ...entry, source: { ...entry.source, kind: 'recentCommand' as const, command: { occurrences: 7, sessionCount: 3, samples: [{ sessionId: 'another-session', threadId: 'another-thread', turnId: 'another-turn', sequence: 7, recordedAtUnixMs: 1000 }] } } };
	const history = { sessionsAvailable: 60, sessionsScanned: 50, commandsAvailable: 2000, commandsScanned: 1000, factsAvailable: 80, factsIncluded: 40 };
	transport.respondAt(-1, { root: '/own-worktree', history, draft: { id: 'scan-id', baseRevision: 3, entries: [historical] } });
	assert.deepEqual(await scan, { root: '/own-worktree', history, id: 'scan-id', baseRevision: 3, entries: [historical] });
	const cancel = environment.cancel('scan-id');
	assert.deepEqual(transport.requests.at(-1)?.params, { operationId: 'scan-id' });
	transport.respondAt(-1, null);
	await cancel;
	const input = { id: entry.id, kind: entry.kind, title: entry.title, content: entry.content, sourceId: entry.source.id };
	const save = environment.save(scope, 'save-id', 3, [input], 'scan-id');
	assert.deepEqual(transport.requests.at(-1)?.params, { scope, commandId: 'save-id', expectedRevision: 3, entries: [input], draftId: 'scan-id' });
	transport.rejectAt(-1, { code: -32091, message: 'ApprovalEnvironmentConflict', data: { kind: 'ApprovalEnvironmentConflict' } });
	await assert.rejects(save, /Rescan before saving/);
	const disabledTransport = new FakeTransport(value => ({ ...value, capabilities: { ...value.capabilities, approvalEnvironment: false } }));
	const disabled = await connectWebRendererApi(disabledTransport, connectorHostServices);
	using disabledCleanup = toDisposable(() => disabled.dispose());
	assert.equal(disabled.api.approvalEnvironment, undefined);
});

class FakeTransport implements AppServerTransport {
	constructor(private readonly initialize: (value: InitializeResult) => unknown = value => value, private readonly initializeDelayMs = 0) {}
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly requests: Array<Record<string, unknown>> = [];
	readonly sentEvents: string[] = [];

	on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
	}

	off(event: string, listener: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	send(event: string, payload?: unknown): void {
		this.sentEvents.push(event);
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, {
				protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION,
				workspaceId: "web-dev:test",
				workspaceRoot: "C:\\workspace",
			});
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT || !isRecord(payload) || typeof payload.frame !== "string") return;
		const request = JSON.parse(payload.frame) as Record<string, unknown>;
		this.requests.push(request);
		if (request.method === "initialize") {
			const result = this.initialize(createTestInitializeResult());
			if (this.initializeDelayMs > 0) {
				setTimeout(() => this.respond(request, result), this.initializeDelayMs);
			} else {
				this.respond(request, result);
			}
		} else if (request.method === "env/dirs/set") {
			this.respond(request, { dirs: [] });
		} else if (request.method === "session/list") {
			this.respond(request, { sessions: [] });
		} else if (request.method === "syntax/open" || request.method === "syntax/update") {
			this.respond(request, null);
		} else if (request.method === "syntax/analyze") {
			this.respond(request, { revision: 4, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] });
		} else if (request.method === "syntax/selectionRanges") {
			this.respond(request, { revision: 4, ranges: [] });
		} else if (request.method === "syntax/close") {
			this.respond(request, null);
		}
	}

	emitNotification(notification: ServerNotification): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", ...notification }) });
	}

	close(message: string): void {
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message });
	}

	respondAt(index: number, result: unknown): void {
		const request = this.requests.at(index);
		if (!request) throw new Error(`No request at index ${index}`);
		this.respond(request, result);
	}

	rejectAt(index: number, error: unknown): void {
		const request = this.requests.at(index);
		if (!request) throw new Error(`No request at index ${index}`);
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", id: request.id, error }) });
	}

	private respond(request: Record<string, unknown>, result: unknown): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
	}

	public emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

test('initialization can outlast bridge connection without timing out', async () => {
	const transport = new FakeTransport(value => value, 20);
	const client = new AppServerProtocolClient(transport, { connectTimeoutMs: 5, initializeTimeoutMs: 5_000 });
	try {
		await client.connect();
		assert.equal(client.state, 'ready');
	} finally { client.dispose(); }
});

test('a compatible newer schema initializes and decodes additive result fields', async () => {
	const transport = new FakeTransport(value => ({
		...value,
		schemaHash: `sha256:${'0'.repeat(64)}`,
		protocolVersion: { ...value.protocolVersion, revision: value.protocolVersion.revision + 1 },
		futureCapability: true,
	}));
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const response = client.request(APP_SERVER_METHODS['automation/list'], {});
		transport.respondAt(-1, { automations: [], futureResultField: 1 });
		assert.deepEqual(await response, { automations: [], futureResultField: 1 });
		assert.equal(client.state, 'ready');
	} finally { client.dispose(); }
});

test('incompatible versions and missing required capabilities never make a connection ready', async () => {
	for (const initialize of [
		(value: InitializeResult) => ({ ...value, protocolVersion: { ...value.protocolVersion, major: value.protocolVersion.major + 1 } }),
		(value: InitializeResult) => ({ ...value, capabilities: { ...value.capabilities, sessions: false } }),
		(value: InitializeResult) => ({ ...value, capabilities: { ...value.capabilities, contracts: { ...value.capabilities.contracts, sessions: { version: APP_SERVER_CAPABILITY_VERSION + 1 } } } }),
	]) {
		const client = new AppServerProtocolClient(new FakeTransport(initialize));
		try {
			await assert.rejects(client.connect(), /protocol major mismatch|capability sessions/);
			assert.equal(client.state, 'crashed');
			await assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}), /not ready/);
		} finally { client.dispose(); }
	}
});

test('a successful handshake does not authorize undeclared notifications', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'future/changed', params: {} }) });
		assert.equal(client.state, 'crashed');
	} finally { client.dispose(); }
});

test("connects, initializes, maps renderer requests, and disposes the Web connection", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	assert.deepEqual(connected.metadata, { workspaceId: "web-dev:test", workspaceRoot: "C:\\workspace" });
	assert.equal(await connected.api.appServer.getConnectionState(), "ready");
	assert.deepEqual(await connected.api.appServer.getSlashCommands(), []);
	assert.deepEqual(await connected.api.session.list(), { sessions: [] });
	assert.deepEqual(hot.requests.map((request) => request.method), ["initialize", "session/list"]);
	assert.equal((hot.requests[0]?.params as { capabilities: { dirPermissionsHost?: unknown } }).capabilities.dirPermissionsHost, undefined);
	connected.dispose();
	assert.equal(hot.sentEvents.at(-1), WEB_APP_SERVER_DISCONNECT_EVENT);
});

test("delivers App Server notifications and reports bridge closure", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const notifications: ServerNotification[] = [];
	const states: string[] = [];
	connected.api.events.subscribe((notification) => notifications.push(notification));
	connected.api.appServer.onConnectionState((state) => states.push(state));
	const notification: ServerNotification = { method: "fs/changed", params: { type: "pathsChanged", paths: ["README.md"] } };
	hot.emitNotification(notification);
	hot.close("test bridge closed");
	assert.deepEqual(notifications, [notification]);
	assert.deepEqual(states, ["crashed"]);
	assert.equal(await connected.api.appServer.getConnectionState(), "crashed");
	connected.dispose();
});

test("routes bounded syntax analysis through the connected renderer host", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);

	await connected.api.syntax.open({ documentId: "model-1", language: "rust", revision: 4, text: "fn main() {}\n" });
	assert.equal(hot.requests.at(-1)?.method, "syntax/open");
	await connected.api.syntax.update({ documentId: "model-1", previousRevision: 4, revision: 5, edits: [{ startOffset: 3, endOffset: 7, text: "entry" }] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/update");
	const result = await connected.api.syntax.analyze({
		documentId: "model-1",
		revision: 4,
	});

	assert.deepEqual(result, { revision: 4, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/analyze");

	assert.deepEqual(await connected.api.syntax.selectionRanges({ documentId: "model-1", revision: 4, ranges: [{ start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } }] }), { revision: 4, ranges: [] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/selectionRanges");
	await connected.api.syntax.close({ documentId: "model-1" });
	assert.equal(hot.requests.at(-1)?.method, "syntax/close");
	connected.dispose();
});

test("uses a stable operation ID to cancel a language request", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	const hoverRequest = hot.requests.at(-1);
	assert.equal(hoverRequest?.method, "language/hover");
	const hoverParams = hoverRequest?.params;
	assert.ok(isRecord(hoverParams));
	assert.equal(typeof hoverParams.operationId, "string");
	assert.ok(isRecord(hoverParams.request));
	assert.ok(isRecord(hoverParams.request.document));
	assert.equal(hoverParams.request.document.path, "src/main.rs");

	cancellation.abort();
	const cancelRequest = hot.requests.at(-1);
	assert.equal(cancelRequest?.method, "language/cancel");
	assert.deepEqual(cancelRequest?.params, { operationId: hoverParams.operationId });
	hot.respondAt(-1, { status: "requested" });

	await assert.rejects(pending, isCancellationError);
	connected.dispose();
});

test("keeps the language result when completion wins the cancel race", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	cancellation.abort();
	hot.respondAt(-2, { revision: 1, contents: "main", range: null });
	hot.respondAt(-1, { status: "completed" });

	assert.deepEqual(await pending, { revision: 1, contents: "main", range: null });
	connected.dispose();
});

test("keeps the language failure when completion wins the cancel race", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	cancellation.abort();
	hot.rejectAt(-2, { code: -32072, message: "LanguageRequestFailed", data: { kind: "LanguageRequestFailed" } });
	hot.respondAt(-1, { status: "completed" });

	await assert.rejects(pending, (error: unknown) => error instanceof AppServerRemoteError && error.errorName === "LanguageRequestFailed");
	connected.dispose();
});

test('renderer dispatches host requests and rejects late results after disconnect', async () => {
	const hot = new FakeTransport();
	const client = new AppServerProtocolClient(hot);
	let signal: AbortSignal | undefined;
	let finish!: (value: { targetId: string }) => void;
	const handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		signal = context.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	await client.connect();
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'host-1', method: 'browser/create', params: { url: 'https://example.test' } }) });
	await Promise.resolve();
	assert.equal(signal?.aborted, false);
	client.disconnect();
	assert.equal(signal?.aborted, true);
	finish({ targetId: 'retired-target' });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(hot.requests.some(request => request.id === 'host-1'), false);
	await client.connect();
	assert.equal(client.generation, 2);
	handler.dispose();
	client.dispose();
});

test('invalid response rejects its pending request and unknown host methods receive method-not-found', async () => {
	const hot = new FakeTransport();
	const client = new AppServerProtocolClient(hot);
	await client.connect();
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'unknown-1', method: 'host/unknown', params: {} }) });
	assert.deepEqual(hot.requests.at(-1)?.error, { code: -32601, message: 'Method not found' });
	assert.equal(client.state, 'ready');
	const pending = client.request(APP_SERVER_METHODS['automation/list'], {});
	hot.respondAt(-1, { automations: 'invalid' });
	await assert.rejects(pending);
	assert.equal(client.state, 'crashed');
	client.dispose();
});

test('Call service is assembled from the negotiated contract and ignores stale or foreign updates', async () => {
	const transport = new FakeTransport(value => ({ ...value, capabilities: { ...value.capabilities, contracts: { ...value.capabilities.contracts, calls: { version: 1 } } } }));
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	try {
		const calls = connected.api.calls;
		assert.ok(calls);
		const starting = calls.start({ type: 'local' });
		const params = transport.requests.at(-1)?.params as { resourceId: string };
		const status = {
			resourceId: params.resourceId, sequence: 1, connection: 'connected' as const,
			call: { id: 'call', revision: 1, mediaEpoch: 1, mediaRoom: 'room', mediaState: { state: 'ready' as const }, members: [{ id: 'owner', role: 'owner' as const }] },
			memberId: 'owner', participants: [], muted: true, deafened: false, microphoneAllowed: true, screenSharing: false, error: null,
		};
		transport.respondAt(-1, status);
		await starting;
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 3, muted: false } });
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 2 } });
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 4, resourceId: 'another-window' } });
		assert.equal(calls.state?.muted, false);
		const leaving = calls.leave();
		transport.respondAt(-1, { ...status, sequence: 4, connection: 'ended', muted: true });
		await leaving;
		assert.equal(calls.state?.connection, 'ended');
	} finally { connected.dispose(); }
});

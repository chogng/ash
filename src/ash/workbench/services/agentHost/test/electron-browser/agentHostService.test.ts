import { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerServiceImpl.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DeferredPromise, TimeoutTimer } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { ISocket, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../../../base/parts/ipc/common/ipc.net.js';
import type { ISandboxGlobals } from '../../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { createTestInitializeResult } from '../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import type { IExtensionHostApi } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import { REMOTE_AGENT_HOST_CLOSE_CHANNEL, REMOTE_AGENT_HOST_OPEN_CHANNEL } from '../../../../../platform/remote/common/remoteConnectionIpc.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import type { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import type { LogEntry } from '../../../../../platform/log/common/log.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';

class RemoteEndpoint extends Disposable implements ISocket {
	private readonly data = this._register(new Emitter<VSBuffer>());
	private readonly close = this._register(new Emitter<SocketCloseEvent>());
	private readonly ended = this._register(new Emitter<void>());
	readonly onData = this.data.event;
	readonly onClose = this.close.event;
	readonly onEnd = this.ended.event;
	readonly handshakes: unknown[] = [];
	write(buffer: VSBuffer): void {
		const frame = JSON.parse(buffer.toString());
		if (frame.method === 'initialize') {
			this.handshakes.push(frame.params);
			this.data.fire(VSBuffer.fromString(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: createTestInitializeResult() }) + '\n'));
		}
	}
	end(): void { this.ended.fire(); }
	async drain(): Promise<void> { }
	traceSocketEvent(_type: SocketDiagnosticsEventType): void { }
}

suite('Desktop Workbench Agent Host selection', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const ports: MessageChannel[] = [];
	const acquired: string[] = [];
	const subscriptions = new Set<(value: unknown) => void>();
	const ipcListeners = new Map<string, Set<(value: unknown) => void>>();
	const disabled = new Set<string>();
	const handshakes: { channel: string; params: unknown; }[] = [];
	let Service: typeof import('../../electron-browser/agentHostService.js').WorkbenchAgentHostService;
	let createRendererApi: typeof import('../../../../electron-browser/rendererApi.js').createElectronRendererApi;
	let testDom: IDisposable;
	let windowConnection: RemoteAgentConnection;
	let onDirectoryBound: ((channel: string) => void) | undefined;
	let onInitialized: ((channel: string) => void) | undefined;
	let onLog: ((entry: LogEntry) => void) | undefined;
	let failDirectoryBinding: boolean;
	let beforeWorkspaceRead: (() => Promise<void>) | undefined;
	let beforeHostOpen: (() => Promise<void>) | undefined;
	const hostOpens: { id: string; connection: { name: string; host: string; workspace: string; }; }[] = [];
	const hostCloses: string[] = [];
	const directoryBindings: { readonly channel: string; readonly dirs: unknown; }[] = [];
	let requestedWorkspace: URI;
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			on: (channel, listener) => {
				subscriptions.add(listener);
				const listeners = ipcListeners.get(channel) ?? new Set();
				ipcListeners.set(channel, listeners);
				listeners.add(listener);
				return { dispose: () => { subscriptions.delete(listener); listeners.delete(listener); if (listeners.size === 0) ipcListeners.delete(channel); } };
			},
			invoke: async (channel, payload) => {
				if (channel === REMOTE_AGENT_HOST_OPEN_CHANNEL) { hostOpens.push(payload as typeof hostOpens[number]); await beforeHostOpen?.(); return; }
				if (channel === REMOTE_AGENT_HOST_CLOSE_CHANNEL) { hostCloses.push((payload as { id: string; }).id); return; }
				if (channel === 'ash:remote:connection') return windowConnection;
				if (channel === 'ash:workspace:context:read') { await beforeWorkspaceRead?.(); return { id: 'desktop', folders: [{ id: 'workspace-folder', uri: requestedWorkspace.toString(), name: 'Project', index: 0 }] }; }
				if (channel.endsWith(':initialized')) { onInitialized?.(channel); return; }
				assert.ok(channel.endsWith(':acquire'), channel);
				acquired.push(channel);
				if (disabled.has(channel)) return { enabled: false };
				const pair = new MessageChannel();
				ports.push(pair);
				pair.port2.on('message', message => {
					if (!(message.data instanceof Uint8Array)) return;
					pair.port2.postMessage({ ack: true });
					const frame = JSON.parse(new TextDecoder().decode(message.data));
					if (frame.method === 'initialize') {
						handshakes.push({ channel, params: frame.params });
						pair.port2.postMessage({ data: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: createTestInitializeResult() }) + '\n') });
					} else if (frame.method === 'config/directoryGrants/read') {
						pair.port2.postMessage({ data: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { dir: frame.params.path, permissions: [] } }) + '\n') });
					} else if (frame.method === 'env/dirs/set') {
						directoryBindings.push({ channel, dirs: frame.params.dirs });
						const response = failDirectoryBinding
							? { jsonrpc: '2.0', id: frame.id, error: { code: -32043, message: 'restore rejected', data: { kind: 'PermissionRequired' } } }
							: { jsonrpc: '2.0', id: frame.id, result: { dirs: frame.params.dirs.map((dir: { id: string; path: string; }) => ({ id: dir.id, path: dir.path, permissions: [] })) } };
						pair.port2.postMessage({ data: new TextEncoder().encode(JSON.stringify(response) + '\n') });
						onDirectoryBound?.(channel);
					}
				});
				dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
					source: dom.window as unknown as Window,
					data: { nonce: (payload as { nonce: string; }).nonce },
					ports: [pair.port1 as unknown as MessagePort],
				}));
				return { enabled: true, byteStream: true, protocolVersion: 1, workspaceId: 'desktop', workspaceRoot: '/workspace' };
			},
		},
		ipcMessagePort: { acquire: () => ({ dispose() { } }) },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};

	suiteSetup(async () => {
		testDom = installEditorTestDom(dom, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'NodeFilter']);
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		Service = (await import('../../electron-browser/agentHostService.js')).WorkbenchAgentHostService;
		createRendererApi = (await import('../../../../electron-browser/rendererApi.js')).createElectronRendererApi;
	});
	suiteTeardown(() => {
		testDom.dispose();
		if (previousGlobals) Object.defineProperty(globalThis, 'ash', previousGlobals); else Reflect.deleteProperty(globalThis, 'ash');
		dom.window.close();
	});
	setup(() => {
		acquired.length = handshakes.length = 0;
		directoryBindings.length = 0;
		onDirectoryBound = onInitialized = onLog = undefined;
		failDirectoryBinding = false;
		beforeHostOpen = beforeWorkspaceRead = undefined;
		hostOpens.length = hostCloses.length = 0;
		windowConnection = { kind: 'ssh', generation: 1, authority: 'ssh+host', host: 'host' };
		requestedWorkspace = createSshRemoteWorkspaceUri('host', '/workspace');
		disabled.clear();
		tracker = new DisposableTracker();
		tracking = installDisposableTracker(tracker);
	});
	teardown(() => {
		try {
			for (const pair of ports.splice(0)) { pair.port1.close(); pair.port2.close(); }
			assert.equal(subscriptions.size, 0);
			tracker.assertNoLeaks();
		} finally { tracking[Symbol.dispose](); }
	});

	function options(connection: RemoteAgentConnection) {
		return {
			connection,
			capabilities: { browser: true, appTools: true, textDocuments: true },
			onDidSuspendOS: () => ({ dispose() { } }),
			onDidResumeOS: () => ({ dispose() { } }),
		} satisfies ConstructorParameters<typeof Service>[0];
	}
	function register(services: InstantiationService, logger: LogService): void {
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		services.registerInstance(ILogService, logger);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
	}

	const mainProcess: IMainProcessService = {
		_serviceBrand: undefined,
		registerChannel: () => { throw new Error('Unexpected renderer channel registration'); },
		getChannel: name => ({
			listen: () => Event.None,
			call: async <T>(command: string, argument?: unknown): Promise<T> => {
				let result: unknown;
				if (name === 'localFilesystem' && ['userDataHome', 'userHome'].includes(command)) result = URI.file('/profile').toString();
				else if (name === 'localFilesystem' && command === 'readFile') result = { bytes: 'e30=', revision: 'settings-1' };
				else if (name === 'policy' && command === 'updatePolicyDefinitions') result = {};
				else if (name === 'logger' && command === 'log') { onLog?.(argument as LogEntry); }
				else throw new Error(`Unexpected renderer channel call: ${name}/${command}`);
				return result as T;
			},
		}),
	};

	function restart(channel: string): void {
		const listeners = ipcListeners.get(channel);
		assert.ok(listeners?.size, `No carrier restart subscription: ${channel}`);
		for (const listener of [...listeners]) listener(undefined);
	}

	test('the runtime registry shares one endpoint, isolates equal servers with different roots, and retires window scopes', async () => {
		using renderer = await createRendererApi([], { browser: false, agentHosts: true }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const registry = renderer.agentHosts!;
		const first = { name: 'Build', host: 'build', workspace: '/repo' };
		const nested = { name: 'Nested', host: 'build', workspace: '/repo/nested' };
		const controller = new AbortController();
		const pending = registry.connect(first, controller.signal);
		assert.equal(registry.connections[0]!.state, 'starting');
		assert.equal(registry.connections[0]!.host, undefined);
		const shared = registry.connect({ ...first, name: 'Renamed' }, new AbortController().signal);
		const host = await pending;
		assert.equal(await shared, host);
		controller.abort();
		assert.equal(registry.connections.length, 1, 'completed acquisition is owned by the runtime rather than its caller signal');
		const second = await registry.connect(nested, new AbortController().signal);
		assert.notEqual(host.id, second.id);
		assert.deepEqual(hostOpens.map(open => open.connection.workspace), ['/repo', '/repo/nested']);
		assert.equal(registry.connections.every(entry => entry.state === 'ready'), true);
		assert.deepEqual(directoryBindings.slice(1).map(entry => entry.dirs), [
			[{ id: `agent-host:${host.id}`, path: '/repo', grant: { type: 'config' } }],
			[{ id: `agent-host:${second.id}`, path: '/repo/nested', grant: { type: 'config' } }],
		]);
		registry.disconnect(host.id);
		assert.deepEqual(registry.connections.map(entry => entry.id), [second.id]);
		host.dispose();
		assert.deepEqual(hostCloses, [host.id]);
		renderer.dispose();
		assert.equal(registry.connections.length, 0);
		assert.deepEqual(hostCloses, [host.id, second.id]);
	});

	test('disconnecting a pending runtime endpoint rejects acquisition and its late Main result cannot publish a host', async () => {
		using renderer = await createRendererApi([], { browser: false, agentHosts: true }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const registry = renderer.agentHosts!;
		const opening = new DeferredPromise<void>();
		beforeHostOpen = () => opening.p;
		const result = registry.connect({ name: 'Build', host: 'build', workspace: '/repo' }, new AbortController().signal);
		const rejected = assert.rejects(result, { name: 'CancellationError' });
		const id = registry.connections[0]!.id;
		registry.disconnect(id);
		await rejected;
		assert.equal(registry.connections.length, 0);
		await opening.complete();
		await Promise.resolve();
		assert.equal(registry.connections.length, 0);
		assert.deepEqual(hostCloses, [id]);
		assert.equal(acquired.some(channel => channel.includes(id)), false);
	});

	test('synchronous registry observers can retire a starting endpoint before Main acquisition', async () => {
		using renderer = await createRendererApi([], { browser: false, agentHosts: true }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const registry = renderer.agentHosts!;
		using listener = registry.onDidChangeConnections(() => {
			const first = registry.connections[0];
			if (first) registry.disconnect(first.id);
		});
		await assert.rejects(registry.connect({ name: 'Build', host: 'build', workspace: '/repo' }, new AbortController().signal), { name: 'CancellationError' });
		assert.equal(hostOpens.length, 0, 'a retired endpoint cannot send OPEN after its own CLOSE');
		assert.equal(registry.connections.length, 0);
	});

	test('runtime reconnect waits for directory rebind, retains its domain scope, and reports failed restoration', async () => {
		using renderer = await createRendererApi([], { browser: false, agentHosts: true }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const registry = renderer.agentHosts!;
		const host = await registry.connect({ name: 'Build', host: 'build', workspace: '/repo' }, new AbortController().signal);
		const generation = host.api.appServer.connectionGeneration;
		const states: string[] = [];
		const subscription = host.api.appServer.onConnectionState(state => states.push(state));
		using listener = toDisposable(() => subscription.dispose());
		const count = directoryBindings.length;
		await registry.reconnect(host.id);
		assert.ok(host.api.appServer.connectionGeneration > generation);
		assert.equal(directoryBindings.length, count + 1);
		assert.deepEqual(directoryBindings.at(-1)!.dirs, [{ id: `agent-host:${host.id}`, path: '/repo', grant: { type: 'config' } }]);
		assert.equal(registry.connections[0]!.host, host);
		assert.equal(await host.api.appServer.getConnectionState(), 'ready');
		assert.ok(states.includes('stopped'));
		assert.ok(states.includes('starting'));
		assert.ok(states.includes('initializing'));
		assert.equal(states.at(-1), 'ready');
		failDirectoryBinding = true;
		await assert.rejects(host.api.appServer.recovery!.reconnect(), /restore rejected/);
		assert.equal(host.api.appServer.recovery!.status, 'failed');
		assert.equal(registry.connections[0]!.state, 'crashed');
		assert.equal(registry.connections[0]!.host, host);
		const unavailable = new DeferredPromise<void>();
		using deadline = new TimeoutTimer(() => { void unavailable.error(new Error('Host carrier did not retire')); }, 5_000);
		using recoveryChanged = host.api.appServer.recovery!.onDidChange(() => { if (host.api.appServer.recovery!.status === 'unavailable') void unavailable.complete(); });
		ports.at(-1)!.port2.postMessage({ intentional: true });
		await unavailable.p;
		assert.equal(registry.connections[0]!.state, 'stopped', 'carrier state must override a previous directory restoration failure');
		assert.equal(host.api.appServer.recovery!.status, 'unavailable');
		assert.notEqual(host.api.appServer.recovery!.error, 'restore rejected');
		failDirectoryBinding = false;
		await registry.reconnect(host.id);
		assert.equal(registry.connections[0]!.state, 'ready');
	});

	test('the production SSH renderer restores current workspace directories only after its execution carrier reconnects', async () => {
		using renderer = await createRendererApi([], { browser: false }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		assert.deepEqual(directoryBindings, [{ channel: 'ash:app-server:acquire', dirs: [{ id: 'workspace-folder', path: '/workspace', grant: { type: 'config' } }] }]);
		const localReconnected = new DeferredPromise<void>();
		onInitialized = channel => { if (channel === 'ash:app-server:local:initialized') void localReconnected.complete(); };
		restart('ash:app-server:local:restart');
		await localReconnected.p;
		assert.equal(directoryBindings.length, 1, 'local device recovery must not rebind the workspace');
		requestedWorkspace = createSshRemoteWorkspaceUri('host', '/next-project');
		const rebound = new DeferredPromise<void>();
		onDirectoryBound = () => { void rebound.complete(); };
		restart('ash:app-server:restart');
		await rebound.p;
		assert.deepEqual(directoryBindings, [
			{ channel: 'ash:app-server:acquire', dirs: [{ id: 'workspace-folder', path: '/workspace', grant: { type: 'config' } }] },
			{ channel: 'ash:app-server:acquire', dirs: [{ id: 'workspace-folder', path: '/next-project', grant: { type: 'config' } }] },
		]);
	});

	test('workspace rebind failure remains failed and concurrent retries restore directories without reconnecting the ready carrier', async () => {
		using renderer = await createRendererApi([], { browser: false }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const recovery = renderer.appServer.recovery!;
		const states: string[] = [];
		const failedState = new DeferredPromise<void>();
		using changed = recovery.onDidChange(() => {
			states.push(recovery.status);
			if (recovery.status === 'failed') void failedState.complete();
		});
		failDirectoryBinding = true;
		const failed = new DeferredPromise<LogEntry>();
		using failureDeadline = new TimeoutTimer(() => {
			void failed.error(new Error('Workspace recovery log was not delivered'));
			void failedState.error(new Error('Workspace recovery failure was not exposed'));
		}, 5_000);
		onLog = entry => { if (entry.message.startsWith('Workspace recovery failed')) void failed.complete(entry); };
		restart('ash:app-server:restart');
		const [diagnostic] = await Promise.all([failed.p, failedState.p]);
		assert.match(String(diagnostic.error), /PermissionRequired|restore rejected/);
		assert.equal(recovery.status, 'failed');
		assert.match(recovery.error!, /restore rejected/);
		assert.equal(directoryBindings.length, 2);
		await assert.rejects(recovery.reconnect(), /restore rejected/);
		assert.equal(recovery.status, 'failed');
		failDirectoryBinding = false;
		const generation = renderer.appServer.connectionGeneration;
		const acquisitions = acquired.length;
		await Promise.all([recovery.reconnect(), recovery.reconnect()]);
		assert.equal(directoryBindings.length, 4, 'concurrent retries share one directory binding');
		assert.equal(renderer.appServer.connectionGeneration, generation);
		assert.equal(acquired.length, acquisitions);
		assert.equal(recovery.status, 'idle');
		assert.equal(recovery.error, undefined);
		assert.ok(states.includes('recovering'));
		assert.ok(directoryBindings.every(binding => binding.channel === 'ash:app-server:acquire'));
		await recovery.reconnect();
		assert.equal(acquired.length, acquisitions + 1, 'an explicit reconnect after full recovery still replaces the carrier');
		assert.ok(renderer.appServer.connectionGeneration > generation);
	});

	test('a retired workspace restoration cannot fail a newer ready connection', async () => {
		using renderer = await createRendererApi([], { browser: false }, { requestWorkspaceTrust: async () => { throw new Error('Saved grants need no prompt'); } }, mainProcess);
		const recovery = renderer.appServer.recovery!;
		const entered = new DeferredPromise<void>();
		const carrierSettled = new DeferredPromise<void>();
		const barrier = new DeferredPromise<void>();
		const restored = new DeferredPromise<void>();
		const staleFailure = new DeferredPromise<void>();
		using deadline = new TimeoutTimer(() => {
			for (const pending of [entered, carrierSettled, restored, staleFailure]) void pending.error(new Error('Workspace restoration did not settle'));
		}, 5_000);
		let first = true;
		beforeWorkspaceRead = async () => {
			if (!first) return;
			first = false;
			void entered.complete();
			await barrier.p;
		};
		using changes = recovery.onDidChange(() => {
			if (entered.isSettled && recovery.status === 'recovering') void carrierSettled.complete();
			if (directoryBindings.length === 2 && recovery.status === 'idle') void restored.complete();
		});
		try {
			restart('ash:app-server:restart');
			await entered.p;
			await carrierSettled.p;
			assert.equal(recovery.status, 'recovering');
			restart('ash:app-server:restart');
			await restored.p;
			assert.equal(recovery.status, 'idle');
			onLog = entry => { if (entry.message.startsWith('Workspace recovery failed')) void staleFailure.complete(); };
			void barrier.error(new Error('Obsolete workspace restoration'));
			await staleFailure.p;
			assert.equal(recovery.status, 'idle');
			assert.equal(recovery.error, undefined);
		} finally {
			void barrier.complete();
		}
	});

	test('local windows select one shared lease and concurrent startup waits for the same handshake', async () => {
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		using host = services.createInstance(Service, options({ kind: 'local', generation: 1 }));
		const startup = host.connect();
		assert.equal(host.connect(), startup);
		assert.equal(await startup, true);
		assert.equal(host.connection, host.localConnection);
		assert.equal(host.client, host.localConnection.client);
		assert.equal(host.client.state, 'ready');
		assert.deepEqual(acquired, ['ash:app-server:acquire']);
	});

	test('SSH windows keep local devices on the local lease and select a separate ready workspace lease', async () => {
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		using suspend = new Emitter<void>();
		using resume = new Emitter<void>();
		register(services, logger);
		using host = services.createInstance(Service, { ...options({ kind: 'ssh', generation: 1, authority: 'ssh+host', host: 'host' }), onDidSuspendOS: suspend.event, onDidResumeOS: resume.event });
		assert.equal(await host.connect(), true);
		assert.notEqual(host.client, host.localConnection.client);
		assert.deepEqual(acquired, ['ash:app-server:local:acquire', 'ash:app-server:acquire']);
		suspend.fire();
		assert.equal(host.localConnection.recovery.status, 'suspended');
		assert.equal(host.connection.recovery.status, 'suspended');
		resume.fire();
		assert.equal(host.localConnection.recovery.status, 'idle');
		assert.equal(host.connection.recovery.status, 'idle');
		host.dispose();
		assert.equal(suspend.hasListeners(), false);
		assert.equal(resume.hasListeners(), false);
		assert.equal(host.localConnection.client.state, 'stopped');
		assert.equal(host.client.state, 'stopped');
	});

	test('disabled local development hosts do not attempt a remote workspace', async () => {
		disabled.add('ash:app-server:local:acquire');
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		using host = services.createInstance(Service, options({ kind: 'ssh', generation: 1, authority: 'ssh+host', host: 'host' }));
		assert.equal(await host.connect(), false);
		assert.deepEqual(acquired, ['ash:app-server:local:acquire']);
	});

	test('a disabled SSH workspace cannot publish the local connection as a successful execution host', async () => {
		disabled.add('ash:app-server:acquire');
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		using host = services.createInstance(Service, options({ kind: 'ssh', generation: 1, authority: 'ssh+host', host: 'host' }));
		await assert.rejects(host.connect(), /remote workspace App Server connection is unavailable/);
		assert.equal(host.connection, host.localConnection);
		assert.deepEqual(acquired, ['ash:app-server:local:acquire', 'ash:app-server:acquire']);
	});

	test('extension remote selection resolves on the local host and initializes the remote extensions before readiness', async () => {
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		const endpoints: RemoteEndpoint[] = [];
		using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
			supports: connection => connection.id === 24,
			connect: async () => { const endpoint = new RemoteEndpoint(); endpoints.push(endpoint); return endpoint; },
		});
		const resolutions: unknown[] = [];
		let extensions: IExtensionHostApi | undefined;
		using host = services.createInstance(Service, {
			...options({ kind: 'remote', generation: 1, authority: 'fixture+host' }),
			resolveRemoteAuthority: async (_api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => {
				resolutions.push({ factories, authority, attempt });
				return { connectTo: new ManagedRemoteConnection(24), connectionToken: undefined };
			},
			initializeRemoteExtensions: async (api: IExtensionHostApi, authority: string) => { assert.equal(authority, 'fixture+host'); extensions = api; return api; },
		});
		assert.equal(await host.connect(), true);
		assert.notEqual(host.client, host.localConnection.client);
		assert.equal(host.windowExtensions, extensions);
		assert.deepEqual(resolutions, [{ factories: services.get(IRemoteSocketFactoryService), authority: 'fixture+host', attempt: 1 }]);
		const remoteHandshake = endpoints[0].handshakes[0] as { capabilities: Record<string, unknown>; };
		assert.equal(remoteHandshake.capabilities.appTools, undefined);
		assert.equal(remoteHandshake.capabilities.directoryGrantsHost, undefined);
		assert.deepEqual(remoteHandshake.capabilities.textDocuments, { version: 2 });
		await host.localConnection.recovery.reconnect();
		await host.connection.whenConnected();
		assert.deepEqual(resolutions, [
			{ factories: services.get(IRemoteSocketFactoryService), authority: 'fixture+host', attempt: 1 },
			{ factories: services.get(IRemoteSocketFactoryService), authority: 'fixture+host', attempt: 2 },
		]);
		assert.equal(endpoints[0].isDisposed, true);
		host.dispose();
		assert.equal(endpoints[1].isDisposed, true);
	});

	test('disposing during remote extension setup rejects startup and never publishes late extension state', async () => {
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const finished = new DeferredPromise<void>();
		const endpoints: RemoteEndpoint[] = [];
		using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
			supports: connection => connection.id === 25,
			connect: async () => { const endpoint = new RemoteEndpoint(); endpoints.push(endpoint); return endpoint; },
		});
		using host = services.createInstance(Service, {
			...options({ kind: 'remote', generation: 1, authority: 'fixture+host' }),
			resolveRemoteAuthority: async () => ({ connectTo: new ManagedRemoteConnection(25), connectionToken: undefined }),
			initializeRemoteExtensions: async (api: IExtensionHostApi) => {
				started.complete();
				await release.p;
				finished.complete();
				return api;
			},
		});
		const rejected = assert.rejects(host.connect());
		await started.p;
		host.dispose();
		release.complete();
		await finished.p;
		await rejected;
		assert.equal(endpoints[0].isDisposed, true);
		assert.equal(host.localConnection.client.state, 'stopped');
		assert.equal(host.windowExtensions, undefined);
	});

	test('remote windows reject absent host resolver capabilities before attempting a remote socket', async () => {
		using services = new InstantiationService();
		using logger = new LogService({ sinks: [] });
		register(services, logger);
		using host = services.createInstance(Service, options({ kind: 'remote', generation: 1, authority: 'fixture+host' }));
		await assert.rejects(host.connect(), /does not provide a local Remote resolver/);
		assert.equal(host.windowExtensions, undefined);
	});

	test('production creation rejects a missing socket factory registration', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(Service, options({ kind: 'local', generation: 1 })), /Unknown service: remoteSocketFactoryService/);
	});

	test('startup connection failures use the selected Chinese language pack', async () => {
		setNlsMessages('zh-cn', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
		try {
			disabled.add('ash:app-server:acquire');
			using services = new InstantiationService();
			using logger = new LogService({ sinks: [] });
			register(services, logger);
			using ssh = services.createInstance(Service, options({ kind: 'ssh', generation: 1, authority: 'ssh+host', host: 'host' }));
			await assert.rejects(ssh.connect(), { message: '远程工作区的 App Server 连接不可用。' });
			disabled.clear();
			using remote = services.createInstance(Service, options({ kind: 'remote', generation: 1, authority: 'fixture+host' }));
			await assert.rejects(remote.connect(), { message: '此窗口未提供本地 Remote 解析器。' });
		} finally { resetNlsResolver(); }
	});
});

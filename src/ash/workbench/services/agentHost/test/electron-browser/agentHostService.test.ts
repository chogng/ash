import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableTracker, installDisposableTracker } from '../../../../../base/common/lifecycle.js';
import type { ISocket, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../../../base/parts/ipc/common/ipc.net.js';
import type { ISandboxGlobals } from '../../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { createTestInitializeResult } from '../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import type { IExtensionHostApi } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';

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
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const ports: MessageChannel[] = [];
	const acquired: string[] = [];
	const subscriptions = new Set<() => void>();
	const disabled = new Set<string>();
	const handshakes: { channel: string; params: unknown; }[] = [];
	let Service: typeof import('../../electron-browser/agentHostService.js').WorkbenchAgentHostService;
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			on: () => { const listener = () => { }; subscriptions.add(listener); return { dispose: () => { subscriptions.delete(listener); } }; },
			invoke: async (channel, payload) => {
				if (channel.endsWith(':initialized')) return;
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
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		Service = (await import('../../electron-browser/agentHostService.js')).WorkbenchAgentHostService;
	});
	suiteTeardown(() => {
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
		if (previousGlobals) Object.defineProperty(globalThis, 'ash', previousGlobals); else Reflect.deleteProperty(globalThis, 'ash');
		dom.window.close();
	});
	setup(() => {
		acquired.length = handshakes.length = 0;
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
		services.registerInstance(ILogService, logger);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
	}

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

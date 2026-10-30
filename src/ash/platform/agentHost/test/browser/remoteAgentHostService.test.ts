import { IWebWorkerService } from '../../../webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../../webWorker/browser/webWorkerServiceImpl.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { ISocket, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../../base/parts/ipc/common/ipc.net.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, type LogEntry } from '../../../log/common/log.js';
import { LogService } from '../../../log/common/logServiceImpl.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../../remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../remote/common/remoteSocketFactoryService.js';
import { RemoteAgentHostService } from '../../browser/remoteAgentHostServiceImpl.js';
import { createTestInitializeResult } from '../common/testAppServerProtocol.js';

class RemotePeer extends Disposable implements ISocket {
	private readonly data = this._register(new Emitter<VSBuffer>());
	private readonly close = this._register(new Emitter<SocketCloseEvent>());
	private readonly ended = this._register(new Emitter<void>());
	readonly onData = this.data.event;
	readonly onClose = this.close.event;
	readonly onEnd = this.ended.event;
	write(buffer: VSBuffer): void {
		const frame = JSON.parse(buffer.toString());
		if (frame.method === 'initialize') {
			this.data.fire(VSBuffer.fromString(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: createTestInitializeResult() }) + '\n'));
		}
	}
	end(): void { this.ended.fire(); }
	async drain(): Promise<void> { }
	traceSocketEvent(_type: SocketDiagnosticsEventType): void { }
}

function registerServices(services: InstantiationService, logger: ILogService): void {
	services.registerInstance(ILogService, logger);
	services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
}

test('remote service reacquires its endpoint and reinitializes extensions after a local restart', async () => {
	using services = new InstantiationService();
	services.registerInstance(IWebWorkerService, new WebWorkerService());
	using logger = new LogService({ sinks: [] });
	using localRestart = new Emitter<void>();
	registerServices(services, logger);
	const sockets: RemotePeer[] = [];
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: connection => connection.id === 17,
		connect: async () => {
			const socket = new RemotePeer();
			sockets.push(socket);
			return socket;
		},
	});
	let initialized = 0;
	let resolutions = 0;
	using service = services.createInstance(RemoteAgentHostService, {
		protocol: { clientName: 'test-remote' },
		getAddress: async () => { resolutions++; return { connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }; },
		getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
		onDidReconnectLocal: localRestart.event,
		initialize: async () => { initialized++; },
	} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
	const client = service.client;
	let reconnects = 0;
	using reconnect = service.onDidReconnect(() => { reconnects++; });
	const initial = service.connect();
	assert.equal(service.connect(), initial);
	await initial;
	assert.equal(reconnects, 0);
	localRestart.fire();
	localRestart.fire();
	await service.whenConnected();
	assert.equal(service.client, client);
	assert.equal(client.state, 'ready');
	assert.deepEqual({ initialized, resolutions, generation: client.generation }, { initialized: 2, resolutions: 2, generation: 2 });
	assert.equal(reconnects, 1);
	assert.equal(sockets[0].isDisposed, true);
	service.dispose();
	assert.equal(sockets[1].isDisposed, true);
	assert.equal(localRestart.hasListeners(), false);
});

test('remote extension initialization failure is logged and retried even while the protocol is ready', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		const entries: LogEntry[] = [];
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		using localRestart = new Emitter<void>();
		registerServices(services, logger);
		using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
			supports: () => true,
			connect: async () => new RemotePeer(),
		});
		let initialized = 0;
		using service = services.createInstance(RemoteAgentHostService, {
			protocol: {},
			getAddress: async () => ({ connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }),
			getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
			onDidReconnectLocal: localRestart.event,
			initialize: async () => {
				if (++initialized === 2) { throw new Error('remote extension initialization failed'); }
			},
		} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
		let reconnects = 0;
		using reconnect = service.onDidReconnect(() => { reconnects++; });
		await service.connect();
		localRestart.fire();
		await assert.rejects(service.whenConnected(), /remote extension initialization failed/);
		assert.equal(service.client.state, 'ready');
		assert.equal(reconnects, 0);
		mock.timers.tick(100);
		await service.whenConnected();
		assert.equal(initialized, 3);
		assert.equal(reconnects, 1);
		const errors = entries.filter(entry => entry.error !== undefined);
		assert.equal(errors.length, 1);
		assert.match((errors[0].error as Error).message, /remote extension initialization failed/);
	} finally { mock.timers.reset(); }
});

test('disposing a remote service during authority resolution prevents late sockets and initialization', async () => {
	using services = new InstantiationService();
	services.registerInstance(IWebWorkerService, new WebWorkerService());
	using logger = new LogService({ sinks: [] });
	using localRestart = new Emitter<void>();
	registerServices(services, logger);
	let release!: () => void;
	const resolved = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const resolving = new Promise<void>(resolve => { entered = resolve; });
	let sockets = 0;
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: () => true,
		connect: async () => { sockets++; return new RemotePeer(); },
	});
	let initialized = 0;
	using service = services.createInstance(RemoteAgentHostService, {
		protocol: {},
		getAddress: async () => { entered(); await resolved; return { connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }; },
		getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
		onDidReconnectLocal: localRestart.event,
		initialize: async () => { initialized++; },
	} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
	const result = assert.rejects(service.connect());
	await resolving;
	service.dispose();
	release();
	await result;
	assert.deepEqual({ sockets, initialized }, { sockets: 0, initialized: 0 });
	assert.equal(localRestart.hasListeners(), false);
});

test('a local restart retires unresolved authority lookup without waiting for its stale result', async () => {
	using services = new InstantiationService();
	services.registerInstance(IWebWorkerService, new WebWorkerService());
	using logger = new LogService({ sinks: [] });
	using localRestart = new Emitter<void>();
	registerServices(services, logger);
	const connections: number[] = [];
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: () => true,
		connect: async connection => {
			connections.push(connection.id);
			return new RemotePeer();
		},
	});
	let release!: () => void;
	const obsolete = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const resolving = new Promise<void>(resolve => { entered = resolve; });
	let resolutions = 0;
	let initialized = 0;
	using service = services.createInstance(RemoteAgentHostService, {
		protocol: {},
		getAddress: async () => {
			if (++resolutions === 1) {
				entered();
				await obsolete;
				return { connectTo: new ManagedRemoteConnection(17), connectionToken: undefined };
			}
			return { connectTo: new ManagedRemoteConnection(18), connectionToken: undefined };
		},
		getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
		onDidReconnectLocal: localRestart.event,
		initialize: async () => { initialized++; },
	} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
	const connecting = service.connect();
	void connecting.catch(() => { });
	await resolving;
	localRestart.fire();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(resolutions, 2);
	await connecting;
	release();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(connections, [18]);
	assert.equal(initialized, 1);
	assert.equal(service.client.state, 'ready');
});

test('a local restart during extension initialization completes only after fresh remote initialization', async () => {
	using services = new InstantiationService();
	services.registerInstance(IWebWorkerService, new WebWorkerService());
	using logger = new LogService({ sinks: [] });
	using localRestart = new Emitter<void>();
	registerServices(services, logger);
	const sockets: RemotePeer[] = [];
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: () => true,
		connect: async () => {
			const socket = new RemotePeer();
			sockets.push(socket);
			return socket;
		},
	});
	let entered!: () => void;
	const initializing = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const obsolete = new Promise<void>(resolve => { release = resolve; });
	let initialized = 0;
	using service = services.createInstance(RemoteAgentHostService, {
		protocol: {},
		getAddress: async () => ({ connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }),
		getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
		onDidReconnectLocal: localRestart.event,
		initialize: async () => {
			if (++initialized === 1) {
				entered();
				await obsolete;
			}
		},
	} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
	const client = service.client;
	const connecting = service.connect();
	await initializing;
	localRestart.fire();
	release();
	await connecting;
	assert.equal(initialized, 2);
	assert.equal(service.client, client);
	assert.equal(client.generation, 2);
	assert.equal(client.state, 'ready');
	assert.equal(sockets[0].isDisposed, true);
});

suite('remote extension initialization retirement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const outcome of ['success', 'failure'] as const) {
		test(`a local restart recovers before obsolete initialization returns ${outcome}`, async () => {
			using services = new InstantiationService();
			services.registerInstance(IWebWorkerService, new WebWorkerService());
			const errors: unknown[] = [];
			using logger = new LogService({ sinks: [{ log: entry => { if (entry.error) errors.push(entry.error); } }] });
			using localRestart = new Emitter<void>();
			registerServices(services, logger);
			const sockets: RemotePeer[] = [];
			using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
				supports: () => true,
				connect: async () => {
					const socket = new RemotePeer();
					sockets.push(socket);
					return socket;
				},
			});
			const entered = new DeferredPromise<void>();
			const obsolete = new DeferredPromise<void>();
			const fresh = new DeferredPromise<void>();
			let initialized = 0;
			using service = services.createInstance(RemoteAgentHostService, {
				protocol: {},
				getAddress: async () => ({ connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }),
				getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
				onDidReconnectLocal: localRestart.event,
				initialize: async () => {
					if (++initialized === 1) {
						await entered.complete();
						await obsolete.p;
					} else {
						await fresh.p;
					}
				},
			} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
			let reconnects = 0;
			using reconnect = service.onDidReconnect(() => { reconnects++; });
			const connecting = service.connect();
			void connecting.catch(() => { });
			await entered.p;
			localRestart.fire();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(initialized, 2, 'fresh initialization must start without the obsolete reply');
			assert.equal(service.whenConnected(), connecting);
			assert.equal(service.recovery.status, 'recovering');
			await fresh.complete();
			await connecting;
			assert.equal(reconnects, 0, 'the first completed incarnation is initialization, not reconnection');
			if (outcome === 'success') { await obsolete.complete(); }
			else { await obsolete.error(new Error('obsolete initialization failed')); }
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(service.client.state, 'ready');
			assert.equal(service.client.generation, 2);
			assert.equal(service.recovery.status, 'idle');
			assert.deepEqual(errors, []);
			assert.equal(reconnects, 0, 'an obsolete initialization cannot publish recovery');
			assert.equal(sockets[0].isDisposed, true);
			service.dispose();
			assert.equal(sockets[1].isDisposed, true);
			assert.equal(localRestart.hasListeners(), false);
		});
	}

	test('transport loss during reinitialization releases the attempt so bounded recovery can retry', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using services = new InstantiationService();
			services.registerInstance(IWebWorkerService, new WebWorkerService());
			using logger = new LogService({ sinks: [] });
			using localRestart = new Emitter<void>();
			registerServices(services, logger);
			const sockets: RemotePeer[] = [];
			using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
				supports: () => true,
				connect: async () => {
					const socket = new RemotePeer();
					sockets.push(socket);
					return socket;
				},
			});
			const entered = new DeferredPromise<void>();
			const obsolete = new DeferredPromise<void>();
			let initialized = 0;
			using service = services.createInstance(RemoteAgentHostService, {
				protocol: {},
				getAddress: async () => ({ connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }),
				getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
				onDidReconnectLocal: localRestart.event,
				initialize: async () => {
					if (++initialized === 2) {
						await entered.complete();
						await obsolete.p;
					}
				},
			} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
			await service.connect();
			localRestart.fire();
			await entered.p;
			const interrupted = assert.rejects(service.whenConnected(), isCancellationError);
			sockets[1].end();
			await interrupted;
			assert.equal(service.recovery.status, 'recovering');
			mock.timers.tick(100);
			await service.whenConnected();
			await obsolete.error(new Error('retired extension setup failed'));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(initialized, 3);
			assert.equal(service.client.generation, 3);
			assert.equal(service.client.state, 'ready');
			assert.equal(service.recovery.status, 'idle');
			assert.deepEqual(sockets.map(socket => socket.isDisposed), [true, true, false]);
		} finally {
			mock.timers.reset();
		}
	});

	test('disposing during extension initialization rejects the connection wait before a late reply', async () => {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		using localRestart = new Emitter<void>();
		registerServices(services, logger);
		const socket = new RemotePeer();
		using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
			supports: () => true,
			connect: async () => socket,
		});
		const entered = new DeferredPromise<void>();
		const obsolete = new DeferredPromise<void>();
		using service = services.createInstance(RemoteAgentHostService, {
			protocol: {},
			getAddress: async () => ({ connectTo: new ManagedRemoteConnection(17), connectionToken: undefined }),
			getMetadata: () => ({ protocolVersion: 1, workspaceId: 'remote', workspaceRoot: '/remote' }),
			onDidReconnectLocal: localRestart.event,
			initialize: async () => {
				await entered.complete();
				await obsolete.p;
			},
		} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]);
		let rejected = false;
		const result = assert.rejects(service.connect(), error => {
			rejected = true;
			return isCancellationError(error);
		});
		await entered.p;
		service.dispose();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(rejected, true, 'disposal must settle the wait independently of extension completion');
		await result;
		await obsolete.complete();
		assert.equal(socket.isDisposed, true);
		assert.equal(localRestart.hasListeners(), false);
	});
});

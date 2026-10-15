import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
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
	using logger = new LogService({ sinks: [] });
	using localRestart = new Emitter<void>();
	registerServices(services, logger);
	const sockets: RemotePeer[] = [];
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: connection => connection.id === 17,
		connect: async () => { const socket = new RemotePeer(); sockets.push(socket); return socket; },
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
	const initial = service.connect();
	assert.equal(service.connect(), initial);
	await initial;
	localRestart.fire();
	localRestart.fire();
	await service.whenConnected();
	assert.equal(service.client, client);
	assert.equal(client.state, 'ready');
	assert.deepEqual({ initialized, resolutions, generation: client.generation }, { initialized: 2, resolutions: 2, generation: 2 });
	assert.equal(sockets[0].isDisposed, true);
	service.dispose();
	assert.equal(sockets[1].isDisposed, true);
	assert.equal(localRestart.hasListeners(), false);
});

test('remote extension initialization failure is logged and retried even while the protocol is ready', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using services = new InstantiationService();
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
		await service.connect();
		localRestart.fire();
		await assert.rejects(service.whenConnected(), /remote extension initialization failed/);
		assert.equal(service.client.state, 'ready');
		mock.timers.tick(100);
		await service.whenConnected();
		assert.equal(initialized, 3);
		const errors = entries.filter(entry => entry.error !== undefined);
		assert.equal(errors.length, 1);
		assert.match((errors[0].error as Error).message, /remote extension initialization failed/);
	} finally { mock.timers.reset(); }
});

test('disposing a remote service during authority resolution prevents late sockets and initialization', async () => {
	using services = new InstantiationService();
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

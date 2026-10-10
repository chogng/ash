import { DeferredPromise } from '../../../../base/common/async.js';
import { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { appServerRequest } from '../../browser/appServerRequest.js';
import { createTestInitializeResult } from '../common/testAppServerProtocol.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent, type SocketDiagnosticsEventType } from '../../../../base/parts/ipc/common/ipc.net.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../remote/common/remoteSocketFactoryService.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../../remote/common/remoteAuthorityResolver.js';
import { AppServerSocketTransport } from '../../browser/appServerSocketTransport.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT } from '../../common/appServerTransport.js';

class PeerSocket extends Disposable implements ISocket {
	private readonly data = this._register(new Emitter<VSBuffer>());
	private readonly close = this._register(new Emitter<SocketCloseEvent>());
	public readonly onData = this.data.event;
	public readonly onClose = this.close.event;
	private readonly endEvent = this._register(new Emitter<void>());
	public readonly onEnd = this.endEvent.event;
	public readonly written: string[] = [];
	public respondToWrite: ((frame: string) => void) | undefined;
	public own(resource: IDisposable): void {
		this._register(resource);
	}
	public write(buffer: VSBuffer): void {
		this.assertNotDisposed();
		this.written.push(buffer.toString());
		this.respondToWrite?.(buffer.toString());
	}
	public receive(bytes: Uint8Array<ArrayBuffer>): void {
		this.data.fire(VSBuffer.wrap(bytes));
	}
	public endPeer(): void { this.endEvent.fire(); }
	public closePeer(): void {
		this.close.fire({ type: SocketCloseEventType.NodeSocketCloseEvent, hadError: false, error: undefined });
	}
	public end(): void {
		this.closePeer();
	}
	public async drain(): Promise<void> { }
	public traceSocketEvent(_type: SocketDiagnosticsEventType): void { }
}

function assemble(socket: PeerSocket): { services: InstantiationService; transport: AppServerSocketTransport; } {
	const services = new InstantiationService();
	services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
	const registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: connection => connection.id === 9,
		connect: async () => socket,
	});
	socket.own(registration);
	const transport = services.createInstance(AppServerSocketTransport, {
		getAddress: async () => ({ connectTo: new ManagedRemoteConnection(9), connectionToken: undefined }),
		getMetadata: () => ({ protocolVersion: 1, workspaceId: 'w', workspaceRoot: '/workspace' }),
	});
	return { services, transport };
}

async function connect(transport: AppServerSocketTransport): Promise<void> {
	const ready = new Promise<void>(resolve => transport.on(WEB_APP_SERVER_CONNECTED_EVENT, () => resolve()));
	transport.send(WEB_APP_SERVER_CONNECT_EVENT);
	await ready;
}

test('App Server socket adapter preserves split UTF-8 frames and serializes one LF per request', async () => {
	using socket = new PeerSocket();
	const assembly = assemble(socket);
	using services = assembly.services;
	using transport = assembly.transport;
	const frames: unknown[] = [];
	transport.on(WEB_APP_SERVER_FRAME_EVENT, value => frames.push(value));
	await connect(transport);
	transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: '{"id":1}' });
	const bytes = new TextEncoder().encode('{"text":"你好"}\n{"id":2}\n');
	socket.receive(bytes.slice(0, 11));
	socket.receive(bytes.slice(11, 14));
	socket.receive(bytes.slice(14));
	assert.deepEqual({ sent: socket.written, frames }, {
		sent: ['{"id":1}\n'],
		frames: [{ frame: '{"text":"你好"}' }, { frame: '{"id":2}' }],
	});
});

test('malformed or unfinished peer frames close the socket and never reach the protocol client', async () => {
	for (const bytes of [new Uint8Array([255, 10]), new TextEncoder().encode('{}\r\n'), new TextEncoder().encode('{}')]) {
		using socket = new PeerSocket();
		const assembly = assemble(socket);
		using services = assembly.services;
		using transport = assembly.transport;
		const closed: unknown[] = [];
		const frames: unknown[] = [];
		transport.on(WEB_APP_SERVER_CLOSED_EVENT, value => closed.push(value));
		transport.on(WEB_APP_SERVER_FRAME_EVENT, value => frames.push(value));
		await connect(transport);
		socket.receive(bytes);
		socket.closePeer();
		assert.equal(closed.length, 1);
		assert.deepEqual(frames, []);
		assert.equal(socket.isDisposed, true);
	}
});

test('disconnect during factory connection disposes a late socket without publishing readiness', async () => {
	using services = new InstantiationService();
	services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
	let finish!: (socket: ISocket) => void;
	const entered = new DeferredPromise<void>();
	using registration = services.get(IRemoteSocketFactoryService).register(RemoteConnectionType.Managed, {
		supports: () => true,
		connect: () => new Promise(resolve => { finish = resolve; void entered.complete(); }),
	});
	using transport = services.createInstance(AppServerSocketTransport, {
		getAddress: async () => ({ connectTo: new ManagedRemoteConnection(1), connectionToken: undefined }),
		getMetadata: () => ({}),
	});
	let ready = false;
	transport.on(WEB_APP_SERVER_CONNECTED_EVENT, () => { ready = true; });
	transport.send(WEB_APP_SERVER_CONNECT_EVENT);
	await entered.p;
	transport.send(WEB_APP_SERVER_DISCONNECT_EVENT);
	using socket = new PeerSocket();
	finish(socket);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ ready, disposed: socket.isDisposed }, { ready: false, disposed: true });
});


test('repeated connect events publish one socket and peer end closes its carrier', async () => {
	using socket = new PeerSocket();
	const assembly = assemble(socket);
	using services = assembly.services;
	using transport = assembly.transport;
	let ready = 0;
	transport.on(WEB_APP_SERVER_CONNECTED_EVENT, () => { ready++; });
	const connected = connect(transport);
	transport.send(WEB_APP_SERVER_CONNECT_EVENT);
	await connected;
	assert.equal(ready, 1);
	const closed = new Promise<unknown>(resolve => transport.on(WEB_APP_SERVER_CLOSED_EVENT, resolve));
	socket.closePeer();
	assert.deepEqual(await closed, { intentional: true, message: undefined });
	assert.throws(() => transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: '{}' }), /Invalid App Server/);
});


test('the real protocol client initializes through the socket adapter and peer close rejects pending requests', async () => {
	using socket = new PeerSocket();
	const assembly = assemble(socket);
	using services = assembly.services;
	using transport = assembly.transport;
	socket.respondToWrite = frame => {
		const request = JSON.parse(frame) as { method: string; id?: number; };
		if (request.method === 'initialize') {
			socket.receive(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: createTestInitializeResult() })}\n`));
		}
	};
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		assert.equal(client.state, 'ready');
		const pending = appServerRequest(client, 'session/list', {});
		const rejected = assert.rejects(pending, /connection stopped/);
		socket.closePeer();
		await rejected;
		assert.equal(client.state, 'stopped');
	} finally {
		client.dispose();
	}
});


test('a managed peer end retires the protocol lease even without a close event', async () => {
	using socket = new PeerSocket();
	const assembly = assemble(socket);
	using services = assembly.services;
	using transport = assembly.transport;
	let closed = 0;
	transport.on(WEB_APP_SERVER_CLOSED_EVENT, () => { closed++; });
	await connect(transport);
	socket.endPeer();
	assert.equal(closed, 1);
	assert.equal(socket.isDisposed, true);
});

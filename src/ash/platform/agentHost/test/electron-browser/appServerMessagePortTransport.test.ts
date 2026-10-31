import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { SocketCloseEventType } from '../../../../base/parts/ipc/common/ipc.net.js';
import { deferAppServerRead } from '../../common/appServerTransport.js';
import { DeferredPromise, TimeoutTimer } from '../../../../base/common/async.js';

suite('App Server MessagePort transport', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const registrations = new Set<string>();
	const requests: { nonce: string; resolve: (value: unknown) => void; reject: (error: Error) => void; }[] = [];
	let Transport: typeof import('../../electron-browser/appServerMessagePortTransport.js').AppServerMessagePortTransport;
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			invoke: (_channel, params) => new Promise((resolve, reject) => { requests.push({ nonce: (params as { nonce: string; }).nonce, resolve, reject }); }),
			on: () => ({ dispose() { } }),
		},
		ipcMessagePort: { acquire: (_channel, nonce) => { registrations.add(nonce); return { dispose: () => { registrations.delete(nonce); } }; } },
		process: { platform: process.platform, arch: process.arch, isBuilt: false },
		webUtils: { getPathForFile: () => '' },
	};
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		Transport = (await import('../../electron-browser/appServerMessagePortTransport.js')).AppServerMessagePortTransport;
	});
	suiteTeardown(() => {
		if (previousWindow) { Object.defineProperty(globalThis, 'window', previousWindow); } else { Reflect.deleteProperty(globalThis, 'window'); }
		if (previousGlobals) { Object.defineProperty(globalThis, 'ash', previousGlobals); } else { Reflect.deleteProperty(globalThis, 'ash'); }
		dom.window.close();
	});
	setup(() => { requests.length = 0; tracker = new DisposableTracker(); tracking = installDisposableTracker(tracker); });
	teardown(() => { try { assert.equal(registrations.size, 0); assert.equal(performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('ash.appServer.port-')).length, 0); tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); } });

	test('disabled hosts settle without a port and release their pending registration', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		requests[0].resolve({ enabled: false });
		assert.equal(await ready, false);
	});

	test('reconnecting keeps only current lease marks and disposing one transport preserves its peer', async () => {
		const first = new Transport(() => { });
		using peer = new Transport(() => { }, 'local');
		const marks = (nonce: string) => performance.getEntriesByType('mark').filter(mark => mark.name.endsWith(`:${nonce}`));
		try {
			const peerReady = peer.acquire();
			const peerNonce = requests.at(-1)!.nonce;
			requests.at(-1)!.resolve({ enabled: false });
			await peerReady;
			let previousNonce: string | undefined;
			for (let index = 0; index < 20; index++) {
				const ready = first.acquire();
				if (previousNonce) assert.equal(marks(previousNonce).length, 0);
				previousNonce = requests.at(-1)!.nonce;
				requests.at(-1)!.resolve({ enabled: false });
				await ready;
				assert.equal(marks(previousNonce).length, 2);
				assert.equal(marks(peerNonce).length, 2);
				assert.equal(performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('ash.appServer.port-')).length, 4);
			}
			first.dispose();
			assert.equal(marks(previousNonce!).length, 0);
			assert.equal(marks(peerNonce).length, 2);
		} finally { first.dispose(); }
	});

	test('a delayed initialization acknowledgement cannot recreate retired lease marks', async () => {
		using transport = new Transport(() => { });
		const channel = new MessageChannel();
		try {
			const ready = transport.acquire();
			const retiredNonce = requests.at(-1)!.nonce;
			requests.at(-1)!.resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window as unknown as Window, data: { nonce: retiredNonce }, ports: [channel.port1 as unknown as MessagePort] }));
			await ready;
			const initialized = transport.initialized();
			const acknowledgement = requests.at(-1)!;
			const successor = transport.acquire();
			const successorNonce = requests.at(-1)!.nonce;
			acknowledgement.resolve(undefined);
			await initialized;
			assert.equal(performance.getEntriesByType('mark').filter(mark => mark.name.endsWith(`:${retiredNonce}`)).length, 0);
			assert.equal(performance.getEntriesByType('mark').filter(mark => mark.name.endsWith(`:${successorNonce}`)).length, 1);
			requests.at(-1)!.resolve({ enabled: false });
			await successor;
		} finally { channel.port1.close(); channel.port2.close(); }
	});

	test('cold SSH validation uses its connection budget instead of the local ten-second deadline', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using transport = new Transport(() => { }, 'workspace', 180_000);
			let settled = false;
			const ready = transport.acquire().finally(() => { settled = true; });
			const rejected = assert.rejects(ready, /App Server port acquisition timed out/);
			mock.timers.tick(10_001);
			await Promise.resolve();
			assert.equal(settled, false);
			assert.equal(registrations.size, 1);
			mock.timers.tick(169_999);
			await rejected;
			assert.equal(registrations.size, 0);
			requests[0].resolve({ enabled: true, byteStream: true });
			await Promise.resolve();
		} finally { mock.timers.reset(); }
	});

	test('host acquisition failure preserves its error and releases the pending registration', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const failure = new Error('host stopped during validation');
		const rejected = assert.rejects(ready, error => error === failure);
		requests[0].reject(failure);
		await rejected;
	});

	test('disposing during acquisition settles its waiter and ignores a late host reply', async () => {
		const transport = new Transport(() => { });
		const ready = transport.acquire();
		const rejected = assert.rejects(ready, { name: 'CancellationError' });
		transport.dispose();
		await rejected;
		requests[0].resolve({ enabled: true, byteStream: true });
		await Promise.resolve();
	});

	test('disposal closes a transferred port before its acquisition continuation can attach it', async () => {
		const transport = new Transport(() => { });
		const channel = new MessageChannel();
		try {
			const ready = transport.acquire();
			const rejected = assert.rejects(ready, { name: 'CancellationError' });
			const closed = new Promise<void>(resolve => channel.port2.once('close', resolve));
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort],
			}));
			transport.dispose();
			requests[0].resolve({ enabled: true, byteStream: true });
			await rejected;
			await closed;
		} finally {
			transport.dispose();
			channel.port1.close();
			channel.port2.close();
		}
	});

	test('a superseded acquisition cannot clear the successor after its delayed host reply', async () => {
		using transport = new Transport(() => { });
		const first = transport.acquire();
		const cancelled = assert.rejects(first, { name: 'CancellationError' });
		const second = transport.acquire();
		await cancelled;
		const channel = new MessageChannel();
		try {
			const metadata = { enabled: true, byteStream: true, protocolVersion: 1, workspaceId: 'current' };
			requests[1].resolve(metadata);
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[1].nonce },
				ports: [channel.port1 as unknown as MessagePort],
			}));
			assert.equal(await second, true);
			requests[0].resolve({ enabled: true, byteStream: true, workspaceId: 'old' });
			await Promise.resolve();
			assert.deepEqual(transport.connectionMetadata, metadata);
			assert.ok(transport.socket);
		} finally { channel.port1.close(); channel.port2.close(); }
	});

	test('byte writes drain only after peer acknowledgements and retirement rejects pending drains', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const channel = new MessageChannel();
		try {
			requests[0].resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort]
			}));
			await ready;
			const socket = transport.socket;
			const received = new Promise<unknown>(resolve => channel.port2.once('message', resolve));
			socket.write(VSBuffer.fromString('你好\n'));
			assert.deepEqual(await received, { data: new TextEncoder().encode('你好\n') });
			let drained = false;
			const drain = socket.drain().then(() => { drained = true; });
			await Promise.resolve();
			assert.equal(drained, false);
			channel.port2.postMessage({ ack: true });
			await drain;
			socket.write(VSBuffer.fromString('{}\n'));
			const rejected = assert.rejects(socket.drain(), /socket is closed/);
			transport.dispose();
			await rejected;
			assert.throws(() => socket.write(VSBuffer.fromString('old')), /socket is closed/);
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

	for (const shared of [false, true]) {
		test(`${shared ? 'shared incoming bytes are copied' : 'incoming bytes reuse received storage'} and acknowledge only after synchronous consumption`, async () => {
			using transport = new Transport(() => { });
			const ready = transport.acquire();
			const channel = new MessageChannel();
			try {
				requests[0].resolve({ enabled: true, byteStream: true });
				dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
					source: dom.window as unknown as Window,
					data: { nonce: requests[0].nonce },
					ports: [channel.port1 as unknown as MessagePort]
				}));
				await ready;
				let receivedArray: Uint8Array | undefined;
				const incomingPort = channel.port1 as unknown as MessagePort;
				const onmessage = incomingPort.onmessage!;
				incomingPort.onmessage = event => {
					receivedArray = (event.data as { data: Uint8Array; }).data;
					onmessage.call(incomingPort, event);
				};
				let consumed = false;
				using subscription = transport.socket.onData(data => {
					if (shared) {
						assert.notEqual(data.buffer.buffer, receivedArray!.buffer);
					} else {
						assert.equal(data.buffer.buffer, receivedArray!.buffer);
						assert.equal(data.buffer.byteOffset, receivedArray!.byteOffset);
					}
					assert.equal(data.toString(), '你好😀\n');
					consumed = true;
				});
				const post = mock.method(channel.port1, 'postMessage', (value: unknown) => {
					assert.equal(consumed, true);
					assert.deepEqual(value, { ack: true });
					channel.port2.close();
				});
				try {
					const closed = new Promise<void>(resolve => channel.port2.once('close', resolve));
					const encoded = new TextEncoder().encode('你好😀\n');
					const storage = new Uint8Array(shared ? new SharedArrayBuffer(encoded.length + 4) : new ArrayBuffer(encoded.length + 4));
					storage.set(encoded, 2);
					channel.port2.postMessage({ data: storage.subarray(2, encoded.length + 2) });
					await closed;
					assert.equal(post.mock.calls.length, 1);
				} finally { post.mock.restore(); }
			} finally {
				channel.port1.close();
				channel.port2.close();
			}
		});
	}


	for (const retire of [false, true]) test(`asynchronous reads retain ACK credit and ${retire ? 'retirement prevents a late ACK' : 'completion returns it'}`, async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const channel = new MessageChannel();
		try {
			requests[0].resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort]
			}));
			await ready;
			const consumed = new DeferredPromise<void>();
			const delivered = new DeferredPromise<void>();
			using subscription = transport.socket.onData(data => { deferAppServerRead(data, consumed.p); void delivered.complete(); });
			const post = mock.method(channel.port1, 'postMessage');
			try {
				channel.port2.postMessage({ data: new TextEncoder().encode('{}\n') });
				await delivered.p;
				assert.equal(post.mock.calls.length, 0);
				if (retire) transport.dispose();
				await consumed.complete();
				assert.deepEqual(post.mock.calls.map(call => call.arguments[0]), retire ? [{ intentional: true }] : [{ ack: true }]);
			} finally { post.mock.restore(); }
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

	test('an intentional Main closure publishes its classified close before generic EOF', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const channel = new MessageChannel();
		try {
			requests[0].resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort]
			}));
			await ready;
			const notifications: string[] = [];
			const closed = new DeferredPromise<void>();
			using deadline = new TimeoutTimer(() => { void closed.error(new Error('Main closure was not delivered')); }, 5_000);
			using close = transport.socket.onClose(event => {
				notifications.push(event?.type === SocketCloseEventType.NodeSocketCloseEvent && !event.hadError ? 'intentional' : 'failed');
				void closed.complete();
			});
			using end = transport.socket.onEnd(() => notifications.push('EOF'));
			channel.port2.postMessage({ intentional: true });
			await closed.p;
			assert.deepEqual(notifications, ['intentional', 'EOF']);
			assert.throws(() => transport.socket, /socket is closed/);
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

	test('releasing the renderer lease tells Main that the closure is intentional', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const channel = new MessageChannel();
		try {
			requests[0].resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort]
			}));
			await ready;
			const released = new Promise<unknown>(resolve => channel.port2.once('message', resolve));
			transport.dispose();
			assert.deepEqual(await released, { intentional: true });
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

	test('exceeding the write queue closes the carrier and rejects drain instead of dropping bytes', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		const channel = new MessageChannel();
		try {
			requests[0].resolve({ enabled: true, byteStream: true });
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[0].nonce },
				ports: [channel.port1 as unknown as MessagePort]
			}));
			await ready;
			const socket = transport.socket;
			for (let index = 0; index < 128; index++) { socket.write(VSBuffer.fromString('{}\n')); }
			const rejected = assert.rejects(socket.drain(), /capacity exceeded/);
			assert.throws(() => socket.write(VSBuffer.fromString('{}\n')), /capacity exceeded/);
			await rejected;
			assert.throws(() => transport.socket, /capacity exceeded/);
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

});

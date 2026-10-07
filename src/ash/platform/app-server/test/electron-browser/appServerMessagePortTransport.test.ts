import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT } from '../../common/appServerTransport.js';

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
		process: { platform: process.platform, arch: process.arch },
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
	teardown(() => { try { assert.equal(registrations.size, 0); tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); } });

	test('disabled hosts settle without a port and release their pending registration', async () => {
		using transport = new Transport(() => { });
		const ready = transport.acquire();
		requests[0].resolve({ enabled: false });
		assert.equal(await ready, false);
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
		requests[0].resolve({ enabled: true });
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
			requests[0].resolve({ enabled: true });
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
			const metadata = { enabled: true, protocolVersion: 1, workspaceId: 'current' };
			requests[1].resolve(metadata);
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: { nonce: requests[1].nonce },
				ports: [channel.port1 as unknown as MessagePort],
			}));
			assert.equal(await second, true);
			requests[0].resolve({ enabled: true, workspaceId: 'old' });
			await Promise.resolve();
			let connected: unknown;
			transport.on(WEB_APP_SERVER_CONNECTED_EVENT, value => { connected = value; });
			transport.send(WEB_APP_SERVER_CONNECT_EVENT);
			assert.deepEqual(connected, metadata);
		} finally { channel.port1.close(); channel.port2.close(); }
	});
});

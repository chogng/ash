import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../../../common/lifecycle.js';
import type { ISandboxGlobals } from '../../../sandbox/electron-browser/sandboxTypes.js';

suite('IPC, MessagePorts', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const registrations = new Set<string>();
	const sent: unknown[][] = [];
	let sendFailure: Error | undefined;
	let ipc: typeof import('../../electron-browser/ipc.mp.js');
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: (channel, ...args) => { if (sendFailure) { throw sendFailure; } sent.push([channel, ...args]); },
			invoke: async () => { throw new Error('Unexpected invocation'); },
			on: () => ({ dispose() {} }),
		},
		ipcMessagePort: { acquire: (channel, nonce) => {
			const key = `${channel}:${nonce}`;
			registrations.add(key);
			return { dispose: () => { registrations.delete(key); } };
		} },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		ipc = await import('../../electron-browser/ipc.mp.js');
	});
	suiteTeardown(() => {
		if (originalWindow) { Object.defineProperty(globalThis, 'window', originalWindow); } else { Reflect.deleteProperty(globalThis, 'window'); }
		if (originalGlobals) { Object.defineProperty(globalThis, 'ash', originalGlobals); } else { Reflect.deleteProperty(globalThis, 'ash'); }
		dom.window.close();
	});
	setup(() => { tracker = new DisposableTracker(); tracking = installDisposableTracker(tracker); sent.length = 0; sendFailure = undefined; });
	teardown(() => { try { assert.equal(registrations.size, 0); tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); } });
	const reply = (data: unknown, ports: readonly MessagePort[] = [], source: Window | null = dom.window as unknown as Window): void => {
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, ports: [...ports], source }));
	};

	test('concurrent acquisitions match their nonce and source before transferring ownership', async () => {
		const first = new MessageChannel();
		const second = new MessageChannel();
		try {
			const a = ipc.acquirePort(undefined, 'ash:test:ports', 'a');
			const b = ipc.acquirePort(undefined, 'ash:test:ports', 'b');
			reply({ nonce: 'a' }, [], null);
			reply({ nonce: 'unrelated' });
			reply('b', [second.port1 as unknown as MessagePort]);
			reply({ nonce: 'a' }, [first.port1 as unknown as MessagePort]);
			assert.deepEqual(await Promise.all([a, b]), [first.port1, second.port1]);
			a.cancel(); b.cancel();
			const received = new Promise(resolve => first.port2.once('message', resolve));
			first.port1.postMessage('still owned by caller');
			assert.equal(await received, 'still owned by caller');
		} finally { first.port1.close(); first.port2.close(); second.port1.close(); second.port2.close(); }
	});

	test('structured failures preserve their message and fatal recovery category', async () => {
		for (const fatal of [false, true]) {
			const result = ipc.acquirePort(undefined, 'ash:test:ports', `failure-${fatal}`);
			const failed = assert.rejects(result, error => error instanceof ipc.MessagePortAcquisitionError
				&& error.message === 'host unavailable' && error.fatal === fatal);
			reply({ nonce: `failure-${fatal}`, error: 'host unavailable', fatal });
			await failed;
		}
	});

	test('cancellation releases both waiting listeners without consuming a later acquisition', async () => {
		const cancelled = ipc.acquirePort(undefined, 'ash:test:ports', 'old');
		const rejected = assert.rejects(cancelled, { name: 'CancellationError' });
		cancelled.cancel(); cancelled.cancel();
		await rejected;
		const channel = new MessageChannel();
		try {
			const current = ipc.acquirePort(undefined, 'ash:test:ports', 'new');
			reply({ nonce: 'old', error: 'late failure' });
			reply({ nonce: 'new' }, [channel.port1 as unknown as MessagePort]);
			assert.equal(await current, channel.port1);
		} finally { channel.port1.close(); channel.port2.close(); }
	});

	test('request dispatch failure rejects and releases the registered preload response', async () => {
		sendFailure = new Error('request channel closed');
		await assert.rejects(ipc.acquirePort('ash:test:request', 'ash:test:ports', 'dispatch'), error => error === sendFailure);
		assert.deepEqual(sent, []);
	});

	test('request channels dispatch the nonce after response registration', async () => {
		const result = ipc.acquirePort('ash:test:request', 'ash:test:ports', 'dispatch');
		assert.deepEqual({ sent, registrations: [...registrations] }, { sent: [['ash:test:request', 'dispatch']], registrations: ['ash:test:ports:dispatch'] });
		const rejected = assert.rejects(result, { name: 'CancellationError' });
		result.cancel();
		await rejected;
	});

	test('responses without a port reject instead of leaving the request pending', async () => {
		const result = ipc.acquirePort(undefined, 'ash:test:ports', 'missing');
		const rejected = assert.rejects(result, /must include exactly one port/);
		reply({ nonce: 'missing' });
		await rejected;
	});

	test('synchronous response delivery also releases the acquisition registration', async () => {
		const channel = new MessageChannel();
		let disposed = 0;
		try {
			const result = ipc.acquirePort(undefined, 'ash:test:ports', 'sync', () => {
				reply('sync', [channel.port1 as unknown as MessagePort]);
				return { dispose: () => { disposed++; } };
			});
			assert.deepEqual({ port: await result, disposed }, { port: channel.port1, disposed: 1 });
		} finally { channel.port1.close(); channel.port2.close(); }
	});
});

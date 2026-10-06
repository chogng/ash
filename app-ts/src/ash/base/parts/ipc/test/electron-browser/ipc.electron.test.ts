import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../../../common/lifecycle.js';
import type { ISandboxGlobals } from '../../../sandbox/electron-browser/sandboxTypes.js';

suite('Electron IPC acquisition', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const registrations = new Set<string>();
	let nonce: string;
	let replyToMain!: () => void;
	let failMain!: (error: Error) => void;
	let ipc: typeof import('../../electron-browser/ipc.electron.js');
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: () => { throw new Error('Unexpected send'); },
			invoke: (channel, ...args) => {
				assert.equal(channel, 'ash:ipc:connect');
				nonce = (args[0] as { nonce: string; }).nonce;
				assert.ok(registrations.has(nonce));
				return new Promise(resolve => { replyToMain = () => resolve(undefined); });
			},
			on: () => ({ dispose() { } }),
		},
		ipcMessagePort: {
			acquire: (channel, value) => {
				assert.equal(channel, 'ash:ipc:port'); registrations.add(value);
				return { dispose: () => { registrations.delete(value); } };
			}
		},
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		ipc = await import('../../electron-browser/ipc.electron.js');
	});
	suiteTeardown(() => {
		if (originalWindow) { Object.defineProperty(globalThis, 'window', originalWindow); } else { Reflect.deleteProperty(globalThis, 'window'); }
		if (originalGlobals) { Object.defineProperty(globalThis, 'ash', originalGlobals); } else { Reflect.deleteProperty(globalThis, 'ash'); }
		dom.window.close();
	});
	setup(() => {
		tracker = new DisposableTracker(); tracking = installDisposableTracker(tracker);
		globals.ipcRenderer.invoke = (channel, ...args) => {
			assert.equal(channel, 'ash:ipc:connect'); nonce = (args[0] as { nonce: string; }).nonce;
			assert.ok(registrations.has(nonce));
			return new Promise((resolve, reject) => { replyToMain = () => resolve(undefined); failMain = reject; });
		};
	});
	teardown(() => { try { assert.equal(registrations.size, 0); tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); } });
	const deliver = (port: MessagePort): void => {
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { nonce }, ports: [port], source: dom.window as unknown as Window }));
	};

	test('concurrent starts share one acquisition and channels wait for both Main and the port', async () => {
		using client = new ipc.Client('window:1');
		assert.throws(() => client.getChannel('system'), /not connected/);
		const first = client.connect();
		assert.equal(client.connect(), first);
		const ports = new MessageChannel();
		try {
			deliver(ports.port1 as unknown as MessagePort);
			await setImmediate();
			assert.throws(() => client.getChannel('system'), /not connected/);
			replyToMain(); await first;
			assert.equal(typeof client.getChannel('system').call, 'function');
		} finally { client.dispose(); ports.port2.close(); }
	});

	test('disposing before port delivery cancels acquisition without waiting for Main', async () => {
		using client = new ipc.Client('window:1');
		const rejected = assert.rejects(client.connect(), { name: 'CancellationError' });
		client.dispose(); await rejected; await setImmediate();
		assert.equal(registrations.size, 0);
		replyToMain();
	});

	test('disposing after port delivery closes it while the Main reply remains pending', async () => {
		using client = new ipc.Client('window:1');
		const rejected = assert.rejects(client.connect(), { name: 'CancellationError' });
		const ports = new MessageChannel();
		try {
			const closed = new Promise<void>(resolve => ports.port2.once('close', resolve));
			deliver(ports.port1 as unknown as MessagePort); await setImmediate();
			client.dispose(); await rejected; await closed;
			assert.equal(registrations.size, 0);
			replyToMain();
		} finally { ports.port1.close(); ports.port2.close(); }
	});

	test('Main rejection releases the waiting port bridge and preserves the failure', async () => {
		using client = new ipc.Client('window:1');
		const denied = new Error('Untrusted renderer');
		const rejected = assert.rejects(client.connect(), error => error === denied);
		failMain(denied); await rejected;
		assert.equal(registrations.size, 0);
	});
});

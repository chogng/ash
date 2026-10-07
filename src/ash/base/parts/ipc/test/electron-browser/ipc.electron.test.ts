import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { VSBuffer } from '../../../../common/buffer.js';
import { Emitter, Event } from '../../../../common/event.js';
import { DisposableStore, DisposableTracker, installDisposableTracker, toDisposable } from '../../../../common/lifecycle.js';
import { IPCClient } from '../../common/ipc.js';
import type { ISandboxGlobals } from '../../../sandbox/electron-browser/sandboxTypes.js';

suite('Electron IPC channels', () => {
	const originalGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const listeners = new Set<(value: unknown) => void>();
	let ipc: typeof import('../../electron-browser/ipc.electron.js');
	let resources: DisposableStore;
	let requests: Emitter<VSBuffer>;
	let main: IPCClient;
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	const sent: string[] = [];
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: (channel, ...args) => {
				sent.push(channel);
				if (channel === 'ash:hello') {
					main = resources.add(new IPCClient({
						onMessage: requests.event,
						send: buffer => queueMicrotask(() => { for (const listener of listeners) { listener(buffer.buffer); } }),
					}, 'window:7'));
					main.registerChannel('echo', {
						call: async <T>(context: string, command: string, arg: unknown): Promise<T> => {
							if (command === 'fail') { throw new TypeError('Invalid operation'); }
							return { context, arg } as T;
						},
						listen: () => Event.None,
					});
					return;
				}
				if (channel === 'ash:message') {
					queueMicrotask(() => requests.fire(VSBuffer.wrap(new Uint8Array(args[0] as Uint8Array))));
					return;
				}
				assert.equal(channel, 'ash:disconnect');
			},
			invoke: async () => { throw new Error('Main channels must not acquire a port'); },
			on: (channel, listener) => {
				assert.equal(channel, 'ash:message');
				listeners.add(listener);
				return { dispose: () => { listeners.delete(listener); } };
			},
		},
		ipcMessagePort: { acquire: () => { throw new Error('Main channels must not acquire a port'); } },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};

	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		ipc = await import('../../electron-browser/ipc.electron.js');
	});
	suiteTeardown(() => {
		if (originalGlobals) { Object.defineProperty(globalThis, 'ash', originalGlobals); } else { Reflect.deleteProperty(globalThis, 'ash'); }
	});
	setup(() => {
		tracker = new DisposableTracker();
		tracking = installDisposableTracker(tracker);
		resources = new DisposableStore();
		requests = resources.add(new Emitter<VSBuffer>());
		sent.length = 0;
	});
	teardown(() => {
		resources.dispose();
		try { assert.equal(listeners.size, 0); tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); }
	});

	test('channels are available immediately and calls follow hello with Main-owned context', async () => {
		using client = new ipc.Client('renderer supplied identity');
		const result = await client.getChannel('echo').call('read', { value: '你好' });
		assert.deepEqual({ result, sent }, {
			result: { context: 'window:7', arg: { value: '你好' } },
			sent: ['ash:hello', 'ash:message'],
		});
		await assert.rejects(client.getChannel('echo').call('fail'), { name: 'TypeError', message: 'Invalid operation' });
		assert.deepEqual(await client.getChannel('echo').call('read', 3), { context: 'window:7', arg: 3 });
	});

	test('Main can invoke a renderer channel over the same connection', async () => {
		using client = new ipc.Client('window:7');
		client.registerChannel('callback', { call: async <T>() => 'renderer response' as T, listen: () => Event.None });
		assert.equal(await main.getChannel('callback').call('read'), 'renderer response');
	});

	test('disposing the document removes its bridge listener and releases server subscriptions', async () => {
		using client = new ipc.Client('window:7');
		let active = 0;
		main.registerChannel('changes', {
			call: async <T>() => undefined as T,
			listen: () => () => { active++; return toDisposable(() => { active--; }); },
		});
		using subscription = client.getChannel('changes').listen('changed')(() => { });
		await setImmediate();
		assert.equal(active, 1);
		client.dispose();
		await setImmediate();
		assert.deepEqual({ active, listeners: listeners.size, last: sent.at(-1) }, { active: 0, listeners: 0, last: 'ash:disconnect' });
	});
});

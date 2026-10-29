import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../base/common/lifecycle.js';
import type { ISandboxGlobals } from '../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IMainProcessService } from '../../../platform/ipc/common/mainProcessService.js';
import { REMOTE_AGENT_CONNECTION_READ_CHANNEL } from '../../../platform/remote/common/remoteAgentApi.js';

test('Electron renderer assembles its connection Worker dependency before Workbench startup and releases failed startup subscriptions', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const subscriptions = new Set<string>();
	const subscribed: string[] = [];
	const nextBoundary = new Error('profile files unavailable');
	const subscribe = (key: string) => {
		assert.equal(subscriptions.has(key), false);
		subscriptions.add(key);
		subscribed.push(key);
		return toDisposable(() => { subscriptions.delete(key); });
	};
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			on: channel => subscribe(channel),
			invoke: async channel => {
				assert.equal(channel, REMOTE_AGENT_CONNECTION_READ_CHANNEL);
				return { kind: 'local', generation: 1 };
			},
		},
		ipcMessagePort: { acquire: () => { throw new Error('connection must not open before profile initialization'); } },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	const mainProcess: IMainProcessService = {
		_serviceBrand: undefined,
		getChannel: name => ({
			listen: event => () => subscribe(`${name}:${event}`),
			call: async command => {
				assert.equal(name, 'localFilesystem');
				assert.equal(command, 'userDataHome');
				throw nextBoundary;
			},
		} satisfies IChannel),
		registerChannel() { throw new Error('renderer must not publish channels'); },
	};
	const values = { window: browser.window, document: browser.window.document, ash: globals };
	const previous = Object.fromEntries(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	try {
		for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, value });
		const { createElectronRendererApi } = await import('../../electron-browser/rendererApi.js');
		for (let attempt = 0; attempt < 2; attempt++) {
			await assert.rejects(createElectronRendererApi([], { browser: false }, {
				requestDirectoryPermissions: async () => { throw new Error('no workspace approval expected'); },
			}, mainProcess), error => error === nextBoundary);
			assert.equal(subscriptions.size, 0, 'failed connection composition must retire its listeners before retry');
		}
		assert.deepEqual(subscribed, Array.from({ length: 2 }, () => [
			'ash:app-server:restart', 'powerMonitor:onDidSuspendOS', 'powerMonitor:onDidResumeOS', 'localFilesystem:fileChange',
		]).flat());
	} finally {
		for (const name of Object.keys(values)) {
			const descriptor = previous[name];
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		browser.window.close();
	}
});

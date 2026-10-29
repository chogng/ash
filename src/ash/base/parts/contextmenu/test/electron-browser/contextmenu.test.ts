import assert from 'node:assert/strict';
import { setup, suite, suiteSetup, suiteTeardown, test } from 'mocha';
import type { ISandboxGlobals } from '../../../sandbox/electron-browser/sandboxTypes.js';
import { NATIVE_CONTEXT_MENU_CLOSE_CHANNEL, NATIVE_CONTEXT_MENU_POPUP_CHANNEL, type INativeContextMenuRequest } from '../../common/contextmenu.js';

suite('Electron context menu transport', () => {
	const originalGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	let menus: typeof import('../../electron-browser/contextmenu.js');
	const calls: { readonly channel: string; readonly params: unknown; }[] = [];
	let invokeResult: unknown;
	let invokeError: Error | undefined;
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: () => { throw new Error('Unexpected send'); },
			async invoke(channel, params) {
				calls.push({ channel, params });
				if (invokeError) { throw invokeError; }
				return invokeResult;
			},
			on: () => { throw new Error('Unexpected subscription'); },
		},
		ipcMessagePort: { acquire: () => { throw new Error('Unexpected port acquisition'); } },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};

	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		menus = await import('../../electron-browser/contextmenu.js');
	});

	suiteTeardown(() => {
		if (originalGlobals) { Object.defineProperty(globalThis, 'ash', originalGlobals); }
		else { Reflect.deleteProperty(globalThis, 'ash'); }
	});

	setup(() => {
		calls.length = 0;
		invokeResult = undefined;
		invokeError = undefined;
	});

	test('popup preserves the request and selected action, and close waits for Main', async () => {
		const request: INativeContextMenuRequest = {
			items: [{ type: 'action', id: 'run', label: 'Run', enabled: true }],
			x: 12.5,
			y: 24,
		};
		invokeResult = { selectedId: 'run' };
		assert.deepEqual(await menus.popup(request), { selectedId: 'run' });
		let finishClose!: () => void;
		invokeResult = new Promise<void>(resolve => { finishClose = resolve; });
		let closed = false;
		const closing = menus.close().then(() => { closed = true; });
		await Promise.resolve();
		assert.equal(closed, false);
		finishClose();
		await closing;
		assert.equal(closed, true);
		assert.deepEqual(calls, [
			{ channel: NATIVE_CONTEXT_MENU_POPUP_CHANNEL, params: request },
			{ channel: NATIVE_CONTEXT_MENU_CLOSE_CHANNEL, params: undefined },
		]);
	});

	test('popup and close preserve IPC failures', async () => {
		invokeError = new Error('Renderer window closed');
		await assert.rejects(menus.popup({ items: [], x: 0, y: 0 }), error => error === invokeError);
		await assert.rejects(menus.close(), error => error === invokeError);
	});
});

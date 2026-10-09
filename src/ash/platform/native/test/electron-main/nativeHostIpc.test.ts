import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { colorSchemeChannel } from '../../electron-main/nativeHostIpc.js';
import type { IColorScheme } from '../../../window/common/window.js';
import { isAdmin, performShellCommand } from '../../electron-main/nativeHostMainService.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../electron-main/nativeHostIpc.js';
import { NATIVE_HOST_IS_ADMIN_CHANNEL, NATIVE_HOST_SHELL_COMMAND_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL } from '../../common/nativeHost.js';
import type { BrowserWindow } from 'electron';
import type { MessageBoxReturnValue } from '../../../../base/parts/sandbox/common/electronTypes.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { DialogMainService } from '../../../dialogs/electron-main/dialogMainService.js';
import { validateNativeDialogOperation, validateOpenDialogResult, validateSaveDialogResult, validateMessageBoxResult } from '../../common/nativeHost.js';

test('shell command IPC reaches the system host and rejects an unsupported installation before writing files', async () => {
	const route = nativeHostIpcRoutes({
		performShellCommand: operation => performShellCommand(operation, { isPackaged: false, executablePath: process.execPath }),
	} as INativeHostMainService).find(route => route.channel === NATIVE_HOST_SHELL_COMMAND_CHANNEL)!;
	assert.throws(() => route.validate('erase'), /Invalid shell command operation/);
	for (const operation of ['install', 'uninstall']) {
		await assert.rejects(async () => route.invoke(route.validate(operation)), process.platform === 'darwin'
			? /requires a packaged Ash application/
			: /requires macOS/);
	}
});

test('desktop privilege reads use the desktop process and accept no renderer arguments', async () => {
	if (process.platform !== 'win32') {
		assert.equal(await isAdmin(), process.geteuid!() === 0);
	}
	let calls = 0;
	const route = nativeHostIpcRoutes({ isAdmin: async () => { calls++; return true; } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_IS_ADMIN_CHANNEL)!;
	assert.throws(() => route.validate({ pid: 123 }), /no arguments/);
	assert.equal(await route.invoke(route.validate(undefined)), true);
	assert.equal(calls, 1);
});

test('the Main color channel exposes only its named read and change event without arguments', async () => {
	using changes = new Emitter<IColorScheme>();
	const scheme = { dark: false, highContrast: true };
	const channel = colorSchemeChannel({
		onDidChangeColorScheme: changes.event,
		getColorScheme: () => scheme,
		getBackgroundColor: () => { throw new Error('Unexpected background read'); },
		saveWindowTheme: async () => { throw new Error('Unexpected theme write'); },
	});
	assert.deepEqual(await channel.call('window:1', 'getOSColorScheme'), scheme);
	await assert.rejects(channel.call('window:1', 'saveWindowTheme'), /Invalid system color scheme read/);
	await assert.rejects(channel.call('window:1', 'getOSColorScheme', { windowId: 2 }), /Invalid system color scheme read/);
	assert.throws(() => channel.listen('window:1', 'unknown'), /Invalid system color scheme subscription/);
	assert.throws(() => channel.listen('window:1', 'onDidChangeColorScheme', true), /Invalid system color scheme subscription/);
	const received: IColorScheme[] = [];
	using subscription = channel.listen<IColorScheme>('window:1', 'onDidChangeColorScheme')(value => received.push(value));
	changes.fire(scheme);
	subscription.dispose();
	changes.fire({ dark: true, highContrast: false });
	assert.deepEqual(received, [scheme]);
});


test('Agents Window handoff preserves optional context sources and rejects malformed attachments', async () => {
	let opened: unknown;
	const route = nativeHostIpcRoutes({ openAgentsWindow: async options => { opened = options; } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL)!;
	const context = { id: 'file', kind: 'file', name: 'brief.ts', content: 'Snapshot', resource: 'file:///workspace/brief.ts' };
	const options = { draft: { mode: 'agent', text: '', contexts: [context, { id: 'text', kind: 'file', name: 'upload.txt', content: 'Upload' }] } };
	await route.invoke(route.validate(options));
	assert.deepEqual(opened, options);
	for (const attachment of [{ ...context, resource: 42 }, { ...context, unexpected: true }, { resource: context.resource }]) {
		assert.throws(() => route.validate({ draft: { ...options.draft, contexts: [attachment] } }), /Invalid Agents Window context/);
	}
});

test('the Renderer Host transports shared dialog options, complete results, and cancellation through Main routes', async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const requests: unknown[] = [];
	let finish!: (result: MessageBoxReturnValue) => void;
	let mainSignal: AbortSignal | undefined;
	let messageShows = 0;
	const window = { id: 7 } as BrowserWindow;
	using dialogs = new DialogMainService({
		showOpenDialog: async (options, owner) => {
			assert.equal(owner, window);
			requests.push(options);
			return { canceled: false, filePaths: ['/one.md', '/two.md'], bookmarks: ['first', 'second'] };
		},
		showSaveDialog: async (options, owner) => {
			assert.equal(owner, window);
			requests.push(options);
			return { canceled: false, filePath: '/report.md', bookmark: 'saved' };
		},
		showMessageBox: async options => {
			messageShows++;
			mainSignal = options.signal;
			return new Promise(resolve => { finish = resolve; });
		},
	});
	const routes = nativeHostIpcRoutes({
		showOpenDialog: options => dialogs.showOpenDialog(options, window),
		showSaveDialog: options => dialogs.showSaveDialog(options, window),
		performDialogOperation: operation => dialogs.perform(window, operation),
	} as INativeHostMainService);
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: () => { throw new Error('Unexpected send'); },
			on: () => { throw new Error('Unexpected subscription'); },
			async invoke(channel, value) {
				const route = routes.find(route => route.channel === channel);
				assert.ok(route);
				return structuredClone(await route.invoke(route.validate(structuredClone(value))));
			},
		},
		ipcMessagePort: { acquire: () => { throw new Error('Unexpected port request'); } },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
	try {
		const { createNativeHostApi } = await import('../../electron-browser/nativeHostApi.js');
		const mainProcess: IMainProcessService = {
			_serviceBrand: undefined,
			getChannel: () => ({ call: async () => { throw new Error('Unexpected channel call'); }, listen: () => { throw new Error('Unexpected channel event'); } }),
			registerChannel: () => { throw new Error('Unexpected channel registration'); },
		};
		const host = createNativeHostApi(mainProcess);
		const open = { title: 'Import', properties: ['openFile', 'multiSelections', 'showHiddenFiles'] as const, securityScopedBookmarks: true };
		const save = { title: 'Export', nameFieldLabel: 'Name', showsTagField: false, properties: ['showOverwriteConfirmation'] as const, securityScopedBookmarks: true };
		assert.deepEqual(await host.showOpenDialog({ ...open, properties: [...open.properties] }), { canceled: false, filePaths: ['/one.md', '/two.md'], bookmarks: ['first', 'second'] });
		assert.deepEqual(await host.showSaveDialog({ ...save, properties: [...save.properties] }), { canceled: false, filePath: '/report.md', bookmark: 'saved' });
		assert.deepEqual(requests, [{ ...open, properties: [...open.properties], defaultPath: undefined }, { ...save, properties: [...save.properties] }]);

		const controller = new AbortController();
		const pending = host.showMessageBox({ message: 'Waiting', buttons: ['Continue', 'Cancel'], cancelId: 1, signal: controller.signal });
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(mainSignal);
		assert.notEqual(mainSignal, controller.signal);
		controller.abort();
		assert.equal(mainSignal.aborted, true);
		finish({ response: 0, checkboxChecked: true });
		assert.deepEqual(await pending, { response: 1, checkboxChecked: false });
		assert.deepEqual(await host.showMessageBox({ message: 'Already cancelled', cancelId: 0, signal: controller.signal }), { response: 0, checkboxChecked: false });
		assert.equal(messageShows, 1);
		const withoutCancelButton = new AbortController();
		const cancellable = host.showMessageBox({ message: 'Waiting without a cancel button', cancelId: -1, signal: withoutCancelButton.signal });
		await Promise.resolve();
		await Promise.resolve();
		withoutCancelButton.abort();
		finish({ response: 0, checkboxChecked: false });
		assert.deepEqual(await cancellable, { response: -1, checkboxChecked: false });
	} finally {
		if (original) Object.defineProperty(globalThis, 'ash', original);
		else Reflect.deleteProperty(globalThis, 'ash');
	}
});

test('dialog boundaries reject legacy requests, non-transferable signals, and malformed results', () => {
	for (const options of [{ message: 'Question', signal: new AbortController().signal }, { message: 'Question', cancelId: 4, buttons: ['Cancel'] }, { message: 'Question', type: 'custom' }]) {
		assert.throws(() => validateNativeDialogOperation({ kind: 'show', id: 1, options }), TypeError);
	}
	assert.throws(() => validateNativeDialogOperation({ kind: 'show', id: 1, request: { kind: 'confirmation', message: 'Question' } }), TypeError);
	assert.throws(() => validateOpenDialogResult(['/one.md']), TypeError);
	assert.throws(() => validateOpenDialogResult({ canceled: false, filePaths: [42] }), TypeError);
	assert.throws(() => validateSaveDialogResult('/report.md'), TypeError);
	assert.throws(() => validateSaveDialogResult({ canceled: 'false', filePath: '/report.md' }), TypeError);
	assert.throws(() => validateMessageBoxResult({ response: 0, checkboxChecked: 'false' }), TypeError);
	assert.deepEqual(validateOpenDialogResult({ canceled: true, filePaths: [] }), { canceled: true, filePaths: [] });
	assert.deepEqual(validateSaveDialogResult({ canceled: true, filePath: '' }), { canceled: true, filePath: '' });
});

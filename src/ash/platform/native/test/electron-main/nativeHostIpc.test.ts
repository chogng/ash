import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { colorSchemeChannel } from '../../electron-main/nativeHostIpc.js';
import type { IColorScheme } from '../../../window/common/window.js';
import { isAdmin, performShellCommand } from '../../electron-main/nativeHostMainService.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../electron-main/nativeHostIpc.js';
import { NATIVE_HOST_IS_ADMIN_CHANNEL, NATIVE_HOST_SHELL_COMMAND_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL } from '../../common/nativeHost.js';

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

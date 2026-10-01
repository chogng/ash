import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { colorSchemeChannel } from '../../electron-main/nativeHostIpc.js';
import type { IColorScheme } from '../../../window/common/window.js';

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

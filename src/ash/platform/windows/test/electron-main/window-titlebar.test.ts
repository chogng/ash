import assert from 'node:assert/strict';
import { test } from 'mocha';
import { WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { defaultWindowState } from '../../../../platform/window/electron-main/window.js';
import { resolveContextMenuStyle } from '../../../../platform/window/common/window.js';
import { resolveBrowserWindowOptions, WindowControlsOverlay } from '../../../../platform/windows/electron-main/windows.js';

test('window options apply the custom titlebar host policy', () => {
	const webPreferences = {
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		preload: 'preload.js',
		additionalArguments: [],
	};
	const state = defaultWindowState(WorkbenchState.FOLDER);
	const customWindows = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: 'win32',
	});
	assert.equal(customWindows.titleBarStyle, 'hidden');
	assert.equal(customWindows.frame, false);
	assert.deepEqual(customWindows.titleBarOverlay, {
		color: '#ffffff',
		symbolColor: '#000000',
		height: 35,
	});

	const customMac = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: 'darwin',
	});
	assert.equal(customMac.titleBarStyle, 'hiddenInset');
	assert.equal(customMac.frame, undefined);
	assert.equal(customMac.titleBarOverlay, true);

	const customLinux = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: 'linux',
	});
	assert.equal(customLinux.titleBarStyle, 'hidden');
	assert.equal(customLinux.frame, false);
	assert.deepEqual(customLinux.titleBarOverlay, {
		color: '#ffffff',
		symbolColor: '#000000',
		height: 35,
	});
	for (const platform of ['win32', 'linux', 'darwin'] as const) {
		const systemTitleBar = resolveBrowserWindowOptions({
			state,
			webPreferences,
			platform,
			titleBarStyle: 'system',
		});
		assert.equal(systemTitleBar.titleBarStyle, undefined);
		assert.equal(systemTitleBar.frame, undefined);
		assert.equal(systemTitleBar.titleBarOverlay, undefined);
	}
});

test('window controls use the startup background and contrasting symbols before the renderer loads', () => {
	const state = defaultWindowState(WorkbenchState.FOLDER);
	const webPreferences = {
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		preload: '',
		additionalArguments: [],
	};
	for (const platform of ['win32', 'linux'] as const) {
		for (const [backgroundColor, symbolColor] of [
			['#ffffff', '#000000'],
			['#123456', '#ffffff'],
			['#000000', '#ffffff'],
		] as const) {
			const options = resolveBrowserWindowOptions({ state, webPreferences, platform, backgroundColor });
			assert.equal(options.backgroundColor, backgroundColor);
			assert.deepEqual(options.titleBarOverlay, { color: backgroundColor, symbolColor, height: 35 });
		}
	}
});

test('system context menus follow the window frame on Windows and Linux', () => {
	assert.deepEqual(
		[
			resolveContextMenuStyle('inherit', 'custom', 'desktop'),
			resolveContextMenuStyle('inherit', 'system', 'desktop'),
			resolveContextMenuStyle('system', 'custom', 'desktop'),
			resolveContextMenuStyle('system', 'system', 'desktop'),
			resolveContextMenuStyle('custom', 'system', 'desktop'),
			resolveContextMenuStyle('system', 'custom', 'macos'),
			resolveContextMenuStyle('system', 'system', 'web'),
		],
		['custom', 'system', 'custom', 'system', 'custom', 'system', 'custom'],
	);
});

test('window controls follow the modal backdrop and restore the latest theme', () => {
	const updates: { color: string; symbolColor: string; height: number }[] = [];
	const controls = new WindowControlsOverlay(colors => updates.push(colors));
	controls.setTheme({ backgroundColor: '#ffffff', symbolColor: '#424242', backdropColor: '#00000080' });
	controls.setDimmed(true);
	controls.setTheme({ backgroundColor: '#202020', symbolColor: '#eeeeee', backdropColor: '#ffffff40' });
	controls.setDimmed(false);
	assert.deepEqual(updates, [
		{ color: '#ffffff', symbolColor: '#424242', height: 35 },
		{ color: '#7e7e7e', symbolColor: '#202020', height: 35 },
		{ color: '#575757', symbolColor: '#f2f2f2', height: 35 },
		{ color: '#202020', symbolColor: '#eeeeee', height: 35 },
	]);
});

test('opaque high-contrast backdrop keeps window control symbols visible', () => {
	const updates: { color: string; symbolColor: string; height: number }[] = [];
	const controls = new WindowControlsOverlay(colors => updates.push(colors));
	controls.setTheme({ backgroundColor: '#000000', symbolColor: '#ffffff', backdropColor: '#000000' });
	controls.setDimmed(true);
	assert.deepEqual(updates.at(-1), { color: '#000000', symbolColor: '#ffffff', height: 35 });
});

test('partial window control colors retain the current theme and modal backdrop', () => {
	const updates: { color: string; symbolColor: string; height: number }[] = [];
	const controls = new WindowControlsOverlay(colors => updates.push(colors));
	controls.setTheme({ backgroundColor: '#ffffff', symbolColor: '#424242', backdropColor: '#00000080' });
	controls.setDimmed(true);
	assert.deepEqual(controls.setTheme({ symbolColor: '#ffffff' }), {
		backgroundColor: '#ffffff',
		symbolColor: '#ffffff',
		backdropColor: '#00000080',
	});
	assert.deepEqual(updates.at(-1), { color: '#7e7e7e', symbolColor: '#7e7e7e', height: 35 });
	controls.setDimmed(false);
	assert.deepEqual(updates.at(-1), { color: '#ffffff', symbolColor: '#ffffff', height: 35 });
});

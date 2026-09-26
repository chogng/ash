import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../base/common/event.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { INativeHostApi } from '../../../platform/native/common/nativeHost.js';
import type { IThemeService } from '../../../platform/theme/common/themeService.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../../platform/window/common/window.js';
import '../desktop.contribution.js';
import { NativeWindow } from '../window.js';
import { bindWindowControlTheme } from '../parts/titlebar/titlebarPart.js';

test('desktop zoom follows the profile setting and persists a window zoom change', async () => {
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(WINDOW_ZOOM_LEVEL_SETTING, 2);
	let zoom = 0;
	let changed: ((level: number) => void) | undefined;
	let applied!: (level: number) => void;
	const firstApplied = new Promise<number>(resolve => { applied = resolve; });
	const host = {
		getZoomLevel: async () => zoom,
		setZoomLevel: async (level: number) => { zoom = level; changed?.(level); applied(level); },
		onDidChangeZoomLevel: (listener: (level: number) => void) => { changed = listener; return { dispose: () => { changed = undefined; } }; },
	} as unknown as INativeHostApi;
	using window = new NativeWindow(host, configuration);
	assert.equal(await firstApplied, 2);
	await new Promise<void>(resolve => setImmediate(resolve));
	const persisted = new Promise<void>(resolve => {
		const subscription = configuration.onDidChangeConfiguration(() => {
			if (configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING) === 3) {
				subscription.dispose();
				resolve();
			}
		});
	});
	zoom = 3;
	changed?.(3);
	await persisted;
	assert.equal(configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING), 3);
});

test('window controls follow theme changes and release their theme listener', () => {
	using changes = new Emitter<never>();
	let color = '#ffffff';
	const themes: unknown[] = [];
	const themeService = {
		getColorTheme: () => ({ id: 'test', getColorCss: () => color }),
		onDidColorThemeChange: changes.event,
	} as unknown as IThemeService;
	const host = { setWindowTheme: async (theme: unknown) => { themes.push(theme); } } as INativeHostApi;
	const binding = bindWindowControlTheme(themeService, host);
	assert.deepEqual(themes, [{ backgroundColor: '#ffffff', symbolColor: '#ffffff', backdropColor: '#ffffff' }]);
	color = '#000000';
	changes.fire(undefined as never);
	assert.deepEqual(themes[1], { backgroundColor: '#000000', symbolColor: '#000000', backdropColor: '#000000' });
	binding.dispose();
	changes.fire(undefined as never);
	assert.equal(themes.length, 2);
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { INativeHostApi } from '../../../platform/native/common/nativeHost.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../../platform/window/common/window.js';
import { StatusbarService } from '../../services/statusbar/browser/statusbar.js';
import type { ICommandService } from '../../../platform/commands/common/commands.js';
import '../desktop.contribution.js';
import { NativeWindow } from '../window.js';

test('desktop zoom follows the profile setting and persists a window zoom change', async () => {
	using configuration = new InMemoryConfigurationService();
	using statusbar = new StatusbarService();
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
	using window = new NativeWindow(host, statusbar, { executeCommand: async () => undefined } as unknown as ICommandService, configuration);
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

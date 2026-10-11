import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateService } from '../../../state/node/stateService.js';
import { ThemeMainService } from '../../electron-main/themeMainServiceImpl.js';
import { resolveBrowserWindowOptions } from '../../../windows/electron-main/windows.js';
import { defaultWindowState } from '../../../window/electron-main/window.js';
import { WorkbenchState } from '../../../workspace/common/workspace.js';

test('the first window follows system light, dark and high contrast themes without cached colors', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-first-window-'));
	try {
		const state = await StateService.create(join(directory, 'state.json'));
		try {
			for (const [dark, highContrast, background] of [[false, false, '#ffffff'], [true, false, '#1e1e1e'], [false, true, '#ffffff'], [true, true, '#000000']] as const) {
				using main = new ThemeMainService({
					shouldUseDarkColors: dark, shouldUseHighContrastColors: highContrast,
					on: () => { }, removeListener: () => { },
				}, state);
				assert.equal(main.getBackgroundColor(), background);
			}
		} finally { await state.close(); }
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('Main publishes distinct OS schemes and restores the saved frame color before a renderer starts', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-main-'));
	const listeners = new Set<() => void>();
	const system = {
		shouldUseDarkColors: false, shouldUseHighContrastColors: false,
		on: (_event: 'updated', listener: () => void) => listeners.add(listener),
		removeListener: (_event: 'updated', listener: () => void) => listeners.delete(listener),
	};
	try {
		const state = await StateService.create(join(directory, 'state.json'));
		using main = new ThemeMainService(system, state);
		const schemes: unknown[] = [];
		using subscription = main.onDidChangeColorScheme(scheme => schemes.push(scheme));
		system.shouldUseDarkColors = true;
		for (const listener of listeners) { listener(); listener(); }
		system.shouldUseHighContrastColors = true;
		for (const listener of listeners) { listener(); }
		assert.deepEqual(schemes, [{ dark: true, highContrast: false }, { dark: true, highContrast: true }]);
		await main.saveWindowTheme({ backgroundColor: '#123456', symbolColor: '#ffffff', backdropColor: '#00000080' });
		await state.close();
		const restored = await StateService.create(join(directory, 'state.json'));
		using next = new ThemeMainService(system, restored);
		assert.equal(next.getBackgroundColor(), '#123456');
		const options = resolveBrowserWindowOptions({
			state: defaultWindowState(WorkbenchState.FOLDER), platform: 'win32', backgroundColor: next.getBackgroundColor(),
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		});
		assert.equal(options.backgroundColor, '#123456');
		assert.deepEqual(options.titleBarOverlay, { color: '#123456', symbolColor: '#ffffff', height: 35 });
		await restored.close();
		next.dispose(); main.dispose();
		assert.equal(listeners.size, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

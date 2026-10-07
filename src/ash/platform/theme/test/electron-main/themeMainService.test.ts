import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateService } from '../../../state/node/stateService.js';
import { ThemeMainService } from '../../electron-main/themeMainServiceImpl.js';

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
		await restored.close();
		next.dispose(); main.dispose();
		assert.equal(listeners.size, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

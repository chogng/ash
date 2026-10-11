import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchElectronApplication } from '../../../automation/playwrightElectron.js';

for (const scenario of [
	{ name: 'first light workbench', source: 'light', background: '#ffffff', agents: false, cached: false },
	{ name: 'first dark Agents window', source: 'dark', background: '#1e1e1e', agents: true, cached: false },
	{ name: 'cached workbench against light system', source: 'light', background: '#123456', agents: false, cached: true },
	{ name: 'cached light Agents window against dark system', source: 'dark', background: '#ffffff', agents: true, cached: true },
] as const) {
	test(scenario.name, async () => {
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-startup-theme-check-'));
		try {
			if (scenario.cached) {
				await writeFile(join(userDataDirectory, 'state.json'), JSON.stringify({ 'theme.window': { backgroundColor: scenario.background, symbolColor: '#ffffff', backdropColor: '#00000080' } }));
			}
			const session = await launchElectronApplication({
				appServerMode: 'disabled', userDataDirectory,
				environment: { ASH_STARTUP_THEME_CHECK_SOURCE: scenario.source },
				extraArgs: scenario.agents ? ['--agents-window'] : [],
			});
			try {
				await expect.poll(() => session.application.evaluate(() => (globalThis as unknown as { ashStartupThemeCheck: unknown[] }).ashStartupThemeCheck)).toEqual([
					{ background: scenario.background, dark: scenario.source === 'dark' },
				]);
			} finally { await session.close(); }
		} finally { await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});
}

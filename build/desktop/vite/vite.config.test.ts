import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { loadConfigFromFile } from 'vite';

test('Desktop and Web development warmup reads existing source files', async () => {
	const path = resolve(import.meta.dirname, 'vite.config.ts');
	for (const mode of ['development', 'web']) {
		const { config } = (await loadConfigFromFile({ command: 'serve', mode }, path))!;
		const files = config.server!.warmup!.clientFiles!;
		assert.ok(files.length > 0);
		await Promise.all(files.map(file => access(file)));
	}
});

test('Desktop and Web keep console diagnostics independent of the HMR connection', async () => {
	const path = resolve(import.meta.dirname, 'vite.config.ts');
	for (const mode of ['development', 'web']) {
		const { config } = (await loadConfigFromFile({ command: 'serve', mode }, path))!;
		assert.equal(config.server!.forwardConsole, false);
	}
});

test('Web development and builds use only browser entries and preserve Desktop output', async () => {
	const path = resolve(import.meta.dirname, 'vite.config.ts');
	const web = (await loadConfigFromFile({ command: 'serve', mode: 'web' }, path))!.config;
	const desktop = (await loadConfigFromFile({ command: 'build', mode: 'production' }, path))!.config;
	const inputs = web.build!.rolldownOptions!.input as Record<string, string>;
	const desktopInputs = desktop.build!.rolldownOptions!.input as Record<string, string>;
	assert.deepEqual(Object.keys(inputs), ['browser/workbench/workbench', 'browser/sessions/sessions', 'browser/theme-preview/themePreview', 'browser/theme-preview/sessionsThemePreview']);
	assert.deepEqual(web.server!.warmup!.clientFiles, [
		inputs['browser/workbench/workbench'],
		resolve(import.meta.dirname, '../../../src/ash/sessions/sessions.web.main.internal.ts'),
		resolve(import.meta.dirname, '../../../src/ash/workbench/contrib/themeEditor/browser/themePreviewPage.ts'),
		resolve(import.meta.dirname, '../../../src/ash/sessions/contrib/themeEditor/browser/themePreviewPage.ts'),
	]);
	assert.match(web.build!.outDir!, /[\\/]web[\\/]ash$/);
	assert.match(desktop.build!.outDir!, /[\\/]renderer[\\/]ash$/);
	assert.ok(Object.keys(desktopInputs).some(entry => entry.startsWith('electron-browser/')));
	assert.ok(Object.hasOwn(desktopInputs, 'sessions/electron-browser/sessions'));
	assert.equal(
		desktop.define!['import.meta.env.ASH_SESSIONS_PROFILE'],
		JSON.stringify({
			id: 'code-sessions',
			label: 'Code Sessions',
			titlebarActionId: 'ash.code.open-sessions',
			workbenchRelativePath: '../workbench/workbench.html',
		}),
	);
});

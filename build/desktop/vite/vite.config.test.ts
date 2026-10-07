import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';

test('Web development and builds use only browser entries and preserve Desktop output', async () => {
	const path = resolve(import.meta.dirname, 'vite.config.ts');
	const web = (await loadConfigFromFile({ command: 'serve', mode: 'web' }, path))!.config;
	const desktop = (await loadConfigFromFile({ command: 'build', mode: 'production' }, path))!.config;
	const inputs = web.build!.rolldownOptions!.input as Record<string, string>;
	assert.deepEqual(Object.keys(inputs), ['browser/workbench/workbench', 'browser/sessions/sessions-code']);
	assert.deepEqual(web.server!.warmup!.clientFiles, Object.values(inputs));
	assert.match(web.build!.outDir!, /[\\/]web[\\/]ash$/);
	assert.match(desktop.build!.outDir!, /[\\/]renderer[\\/]ash$/);
	assert.ok(Object.keys(desktop.build!.rolldownOptions!.input!).some(entry => entry.startsWith('electron-browser/')));
});

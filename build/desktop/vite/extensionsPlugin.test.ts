import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from 'vite';
import { browserExtensionsPlugin } from './extensionsPlugin.ts';

test('development publishes checkout locations for built-in theme editing and builds omit them', async () => {
	const options = { configFile: false as const, plugins: [browserExtensionsPlugin()] };
	const development = await resolveConfig(options, 'serve');
	assert.ok(development.define);
	const locations = JSON.parse(development.define['import.meta.env.ASH_BUILTIN_THEME_SOURCES']);
	assert.equal(
		locations['vscode.theme-defaults'],
		pathToFileURL(resolve(import.meta.dirname, '../../../extensions/theme-defaults')).href,
	);
	assert.ok(
		Object.values(locations).every(location => typeof location === 'string' && !location.includes('/.build/')),
	);
	const production = await resolveConfig(options, 'build');
	assert.ok(production.define);
	assert.deepEqual(JSON.parse(production.define['import.meta.env.ASH_BUILTIN_THEME_SOURCES']), {});
});

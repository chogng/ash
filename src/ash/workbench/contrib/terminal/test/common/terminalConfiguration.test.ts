import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { IJSONSchemaSnippet } from '../../../../../base/common/jsonSchema.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { TERMINAL_CONFIG_SECTION } from '../../common/terminal.js';
import { registerTerminalConfiguration } from '../../common/terminalConfiguration.js';

test('terminal font suggestions update the registered schema without delaying setting availability', async () => {
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	const fontFamilyKey = `${TERMINAL_CONFIG_SECTION}.fontFamily`;
	const setting = registry.getConfiguration(fontFamilyKey);
	assert.ok(setting?.schema);
	const originalSnippets = setting.schema.defaultSnippets;
	const pending = new DeferredPromise<IJSONSchemaSnippet[]>();
	const registration = registerTerminalConfiguration(() => pending.p);
	try {
		assert.strictEqual(registry.getConfiguration(fontFamilyKey), setting);
		assert.equal(setting.parse('Test Mono'), 'Test Mono');
		assert.strictEqual(setting.schema.defaultSnippets, originalSnippets);
		const snippets = [{ body: 'Test Mono' }, { body: 'Test Serif' }];
		await pending.complete(snippets);
		await registration;
		assert.strictEqual(registry.getConfiguration(fontFamilyKey)?.schema, setting.schema);
		assert.deepEqual(setting.schema.defaultSnippets, snippets);
		snippets.push({ body: 'Later Font' });
		assert.deepEqual(setting.schema.defaultSnippets, [{ body: 'Test Mono' }, { body: 'Test Serif' }]);
	} finally {
		Object.assign(setting.schema, { defaultSnippets: originalSnippets });
	}
});

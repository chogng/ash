import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';

function integer(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError('value must be a positive integer');
	return value as number;
}

test('in-memory configuration resolves base and language override values', async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({ key: 'editor.tabSize', defaultValue: 4, parse: integer });
	registry.registerConfiguration({ key: 'editor.insertSpaces', defaultValue: true, parse: value => Boolean(value) });
	using service = new InMemoryConfigurationService(registry);
	const events: Array<{
		readonly source: ConfigurationTarget;
		readonly keys: readonly string[];
		readonly overrides: readonly [string, string[]][];
		readonly affectsTypeScript: boolean;
		readonly affectsJavaScript: boolean;
	}> = [];
	using listener = service.onDidChangeConfiguration(event => {
		events.push({
			source: event.source,
			keys: event.change.keys,
			overrides: event.change.overrides,
			affectsTypeScript: event.affectsConfiguration('editor.tabSize', { overrideIdentifier: 'typescript' }),
			affectsJavaScript: event.affectsConfiguration('editor.tabSize', { overrideIdentifier: 'javascript' }),
		});
	});

	await service.updateValue(tabSize, 8);
	await service.updateValue(tabSize, 2, { overrideIdentifier: 'typescript' }, ConfigurationTarget.MEMORY);

	assert.equal(service.getValue(tabSize), 8);
	assert.equal(service.getValue(tabSize, { overrideIdentifier: 'typescript' }), 2);
	assert.equal(service.getValue(tabSize, { overrideIdentifier: 'javascript' }), 8);
	assert.deepEqual(service.getValue('editor', { overrideIdentifier: 'typescript' }), { tabSize: 2, insertSpaces: true });
	assert.deepEqual(events, [
		{
			source: ConfigurationTarget.MEMORY,
			keys: ['editor.tabSize'],
			overrides: [],
			affectsTypeScript: true,
			affectsJavaScript: true,
		},
		{
			source: ConfigurationTarget.MEMORY,
			keys: [],
			overrides: [['typescript', ['editor.tabSize']]],
			affectsTypeScript: true,
			affectsJavaScript: false,
		},
	]);
	assert.deepEqual(service.inspect<number>(tabSize, { overrideIdentifier: 'typescript' }), {
		defaultValue: 4,
		value: 2,
		default: { value: 4 },
		memoryValue: 2,
		memory: {
			value: 8,
			override: 2,
			overrides: [{ identifiers: ['typescript'], value: 2 }],
		},
		overrideIdentifiers: ['typescript'],
	});
});

test('in-memory configuration validates writes and reports canonical data', async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({ key: 'editor.tabSize', defaultValue: 4, parse: integer });
	using service = new InMemoryConfigurationService(registry);

	await assert.rejects(service.updateValue('editor.unknown', 2), /not registered/u);
	await assert.rejects(service.updateValue(tabSize, 0), /positive integer/u);
	await service.updateValue(tabSize, 6, { overrideIdentifiers: ['typescript', 'typescript', 'javascript'] });
	assert.deepEqual(service.inspect<number>(tabSize, { overrideIdentifier: 'typescript' }).memory?.overrides, [
		{ identifiers: ['javascript', 'typescript'], value: 6 },
	]);

	assert.deepEqual(service.keys(), {
		default: ['editor.tabSize'],
		policy: [],
		user: [],
		workspace: [],
		workspaceFolder: [],
		memory: ['editor.tabSize'],
	});
	assert.deepEqual(service.getConfigurationData().defaults, {
		contents: { editor: { tabSize: 4 } },
		keys: ['editor.tabSize'],
		overrides: [],
	});
	assert.equal(service.getValue(tabSize, { overrideIdentifier: 'typescript' }), 6);
	assert.equal(service.getValue(tabSize, { overrideIdentifier: 'javascript' }), 6);
	await service.updateValue(tabSize, undefined, { overrideIdentifiers: ['typescript', 'javascript'] });
	assert.equal(service.getValue(tabSize, { overrideIdentifier: 'typescript' }), 4);
	await service.reloadConfiguration(ConfigurationTarget.MEMORY);
});

test('in-memory configuration rejects unsupported owners and compares effective override values', async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({ key: 'editor.tabSize', defaultValue: 4, parse: integer });
	using service = new InMemoryConfigurationService(registry);

	await service.updateValue(tabSize, 8, { overrideIdentifier: 'typescript' }, ConfigurationTarget.MEMORY);
	let affectsTypeScript: boolean | undefined;
	let affectsJavaScript: boolean | undefined;
	using listener = service.onDidChangeConfiguration(event => {
		affectsTypeScript = event.affectsConfiguration(tabSize, { overrideIdentifier: 'typescript' });
		affectsJavaScript = event.affectsConfiguration(tabSize, { overrideIdentifier: 'javascript' });
	});
	await service.updateValue(tabSize, 6, ConfigurationTarget.MEMORY);

	assert.equal(affectsTypeScript, false);
	assert.equal(affectsJavaScript, true);
	await assert.rejects(service.updateValue(tabSize, 2, ConfigurationTarget.USER), /Unable to write editor\.tabSize to target 2/u);
	await assert.rejects(service.updateValue(tabSize, 2, 99 as ConfigurationTarget), /target is invalid/u);
	await assert.rejects(
		service.updateValue(tabSize, 2, { resource: URI.parse('file:///workspace/file.ts') }, ConfigurationTarget.MEMORY),
		/does not support resource overrides/u,
	);
	await assert.rejects(service.reloadConfiguration(ConfigurationTarget.USER), /Unable to reload in-memory configuration target 2/u);
});

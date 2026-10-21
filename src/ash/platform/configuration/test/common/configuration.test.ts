import { ConfigurationModelParser } from '../../common/configurationModels.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { FileRevisionConflictError } from '../../../files/common/files.js';
import { TestConfigurationFiles } from '../../../../workbench/services/configuration/test/common/testServices.js';
import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import { URI } from "../../../../base/common/uri.js";
import {
	ConfigurationRegistry,
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from "../../../../platform/configuration/common/configurationRegistry.js";
import { InMemoryConfigurationService } from "../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { Registry } from "../../../../platform/registry/common/platform.js";


import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../workbench/services/configuration/test/common/testServices.js';

import { ConfigurationTarget, addToValueTree, getConfigValueInTarget, getConfigurationValue, getLanguageTagSettingPlainKey, isConfigurationOverrides, isConfigurationUpdateOverrides, isConfigured, merge, removeFromValueTree, toValuesTree } from "../../../../platform/configuration/common/configuration.js";

test('extension language defaults merge atomically, respect user overrides and withdraw without writing settings', async () => {
	const registry = new ConfigurationRegistry();
	registry.updateConfigurations({
		add: [{
			properties: {
				'wrap.mode': { type: 'string', enum: ['off', 'on'], default: 'off', scope: 5 },
				'wrap.column': { type: 'integer', default: 80, scope: 5 },
			}
		}], remove: []
	});
	const source = '// keep user settings\n{"wrap.mode":"off"}\n';
	using service = new WorkbenchConfigurationService({ registry, source });
	const first = { overrides: { '[markdown]': { 'wrap.mode': 'on' } } };
	const second = { overrides: { '[markdown]': { 'wrap.column': 100 } } };
	const changes: unknown[] = [];
	using listener = service.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('wrap', { overrideIdentifier: 'markdown' })) changes.push(service.getValue('wrap', { overrideIdentifier: 'markdown' }));
	});
	registry.deltaConfiguration({ addedDefaults: [first, second] });
	assert.deepEqual(service.getValue('wrap', { overrideIdentifier: 'markdown' }), { mode: 'on', column: 100 });
	assert.equal(service.getValue('wrap.mode'), 'off');
	assert.equal(service.getValue('wrap.mode', { overrideIdentifier: 'typescript' }), 'off');
	assert.equal(service.inspect('wrap.mode', { overrideIdentifier: 'markdown' }).defaultValue, 'on');
	assert.equal((await service.read()).source, source);
	assert.equal(changes.length, 1);
	assert.throws(() => registry.deltaConfiguration({ removedDefaults: [first], addedDefaults: [{ overrides: { '[markdown]': { 'wrap.mode': 'invalid' } } }] }));
	assert.equal(service.getValue('wrap.mode', { overrideIdentifier: 'markdown' }), 'on');
	assert.equal(changes.length, 1, 'failed replacements publish no partial change');
	await service.updateValue('wrap.mode', 'off', { overrideIdentifier: 'markdown' });
	assert.equal(service.getValue('wrap.mode', { overrideIdentifier: 'markdown' }), 'off');
	registry.deltaConfiguration({ removedDefaults: [first, second] });
	assert.equal(service.inspect('wrap.mode', { overrideIdentifier: 'markdown' }).defaultValue, 'off');
	assert.equal(service.getValue('wrap.column', { overrideIdentifier: 'markdown' }), 80);
	assert.equal(service.getValue('wrap.mode', { overrideIdentifier: 'markdown' }), 'off');
});

test('workbench change events index ancestor and descendant sections without matching adjacent names', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'editor.options', defaultValue: { fontSize: 12 }, parse: value => value as { fontSize: number; } });
	registry.registerConfiguration({ key: 'editorial.enabled', defaultValue: true, parse: Boolean });
	using service = new WorkbenchConfigurationService({ registry });
	const events: import('../../common/configuration.js').IConfigurationChangeEvent[] = [];
	using listener = service.onDidChangeConfiguration(event => events.push(event));
	await service.updateValue('editor.options', { fontSize: 16 });
	await service.updateValue('editorial.enabled', false);

	const sections = ['editor', 'editor.options', 'editor.option', 'editor.options.fontSize', 'editorial', '', 'editor.', 'Editor'];
	assert.deepEqual(events.map(event => sections.map(section => event.affectsConfiguration(section))), [
		[true, true, false, true, false, false, false, false],
		[false, false, false, false, true, false, false, false],
	]);
	assert.deepEqual(events.map(event => [...event.affectedKeys]), [['editor.options'], ['editorial.enabled']]);
	assert.equal(events[0]!.affectsConfiguration('editor.options.fontSize'), true, 'an older event retains its own index');
});

test('configuration tags are validated before replacing live registrations', () => {
	const registry = new ConfigurationRegistry();
	const active = { properties: { 'test.active': { type: 'boolean' as const, default: true, tags: ['preview'] } } };
	registry.updateConfigurations({ add: [active], remove: [] });
	assert.throws(() => registry.updateConfigurations({ add: [{ properties: { 'test.invalid': { type: 'boolean', default: false, tags: [1] as unknown as string[] } } }], remove: [active] }), /Configuration tags/);
	assert.deepEqual(registry.getConfiguration('test.active')?.tags, ['preview']);
	assert.equal(registry.getConfiguration('test.invalid'), undefined);
	assert.throws(() => registry.registerConfiguration({ key: 'test.invalid', defaultValue: false, parse: Boolean, tags: [' '] }), /Configuration tags/);
});

test('reused configuration reads observe new layers inside change listeners and preserve language overrides', async () => {
	const registry = new ConfigurationRegistry();
	registry.updateConfigurations({ add: [{ properties: { 'cache.palette': { type: 'object', default: { enabled: true }, scope: 5 } } }], remove: [] });
	using service = new WorkbenchConfigurationService({ registry, source: '{"[javascript]":{"cache.palette":{"enabled":false}}}' });
	const initial = service.getValue('cache.palette');
	assert.deepEqual(initial, { enabled: true });
	assert.ok(Object.isFrozen(initial));
	const observed: unknown[] = [];
	using listener = service.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('cache.palette')) observed.push(service.getValue('cache.palette'));
	});
	await service.updateValue('cache.palette', { enabled: true, label: 'updated' });
	assert.deepEqual(service.getValue('cache.palette'), { enabled: true, label: 'updated' });
	assert.deepEqual(service.getValue('cache.palette', { overrideIdentifier: 'javascript' }), { enabled: false, label: 'updated' });
	await service.updateValue('cache.palette', undefined);
	assert.deepEqual(service.getValue('cache.palette'), { enabled: true });
	assert.deepEqual(observed, [{ enabled: true, label: 'updated' }, { enabled: true }]);
	assert.deepEqual(initial, { enabled: true }, 'previous configuration snapshots remain immutable');
});

test('contributed configuration replacement updates live values atomically and preserves stored user settings', async () => {
	const registry = new ConfigurationRegistry();
	const source = '// preserved user settings\n{"contributed.value":"saved","[typescript]":{"contributed.value":"typed"}}\n';
	using service = new WorkbenchConfigurationService({ registry, source: source });
	const changes: { keys: string[]; source: ConfigurationTarget; valueAffected: boolean; sectionAffected: boolean; }[] = [];
	using listener = service.onDidChangeConfiguration(event => {
		changes.push({ keys: [...event.affectedKeys].sort(), source: event.source, valueAffected: event.affectsConfiguration('contributed.value', { resource: URI.file('/project/main.ts') }), sectionAffected: event.affectsConfiguration('contributed', { overrideIdentifier: 'typescript' }) });
	});
	const first = { properties: { 'contributed.value': { type: 'string' as const, default: 'default', scope: 5 }, 'contributed.count': { type: 'integer' as const, default: 7, minimum: 1 } } };
	assert.equal(service.getValue('contributed.value'), undefined);
	registry.updateConfigurations({ add: [first], remove: [] });
	assert.deepEqual({ value: service.getValue('contributed.value'), typed: service.getValue('contributed.value', { overrideIdentifier: 'typescript' }), count: service.getValue('contributed.count') }, { value: 'saved', typed: 'typed', count: 7 });
	const invalid = { properties: { 'contributed.count': { type: 'integer' as const, default: 'invalid' } } };
	assert.throws(() => registry.updateConfigurations({ add: [invalid], remove: [first] }), /declared schema/);
	assert.equal(service.getValue('contributed.count'), 7);
	assert.equal(changes.length, 1);
	const second = { properties: { 'contributed.value': { type: 'string' as const, default: 'changed', scope: 5 }, 'contributed.count': { type: 'integer' as const, default: 9 } } };
	registry.updateConfigurations({ add: [second], remove: [first] });
	assert.deepEqual({ value: service.getValue('contributed.value'), count: service.getValue('contributed.count') }, { value: 'saved', count: 9 });
	registry.updateConfigurations({ add: [], remove: [second] });
	assert.equal(service.getValue('contributed.value'), undefined);
	assert.equal(service.getConfigurationData().userLocal.keys.includes('contributed.value'), false);
	assert.deepEqual(changes, Array.from({ length: 3 }, (_, index) => ({ keys: ['contributed.count', 'contributed.value'], source: ConfigurationTarget.DEFAULT, valueAffected: index !== 1, sectionAffected: true })));
	assert.equal((await service.read()).source, source);
});

test("configuration registry is owned by the standard platform Registry entry", async () => {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	assert.equal(Registry.knows(ConfigurationExtensions.Configuration), true);
	const enabled = registry.registerConfiguration({
		key: "test.configuration.registry.enabled",
		defaultValue: false,
		parse(value): boolean {
			if (typeof value !== "boolean") throw new TypeError("enabled must be a boolean");
			return value;
		},
	});
	using service = new InMemoryConfigurationService();
	const changes: string[] = [];
	using listener = service.onDidChangeConfiguration(event => changes.push(...event.change.keys));

	assert.equal(service.getValue(enabled), false);
	await service.updateValue(enabled, true);
	assert.equal(service.getValue(enabled), true);
	assert.deepEqual(changes, [enabled]);
});

test("configuration contracts expose target inspection and validate overrides", () => {
	const values = { defaultValue: 12, userValue: 14, workspaceValue: 16 };
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.DEFAULT), 12);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.USER), 14);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.WORKSPACE), 16);
	assert.equal(getConfigValueInTarget(values, ConfigurationTarget.MEMORY), undefined);
	assert.equal(isConfigurationOverrides({ overrideIdentifier: "typescript" }), true);
	assert.equal(isConfigurationOverrides({ resource: URI.parse("file:///workspace/file.ts") }), true);
	assert.equal(isConfigurationOverrides({ overrideIdentifier: 1 }), false);
	assert.equal(isConfigurationOverrides({ resource: {} }), false);
	assert.equal(isConfigurationUpdateOverrides({ overrideIdentifiers: ["typescript"] }), true);
	assert.equal(isConfigurationUpdateOverrides({ overrideIdentifier: "typescript" }), false);
	assert.equal(isConfigured(values), true);
	assert.equal(isConfigured({ defaultValue: 12 }), false);
});

test("configuration value-tree helpers preserve canonical section semantics", () => {
	const conflicts: string[] = [];
	const values = toValuesTree({ "editor.fontSize": 14, "editor.wordWrap": "on" }, message => conflicts.push(message));
	assert.equal(Object.getPrototypeOf(values), null);
	assert.equal(Object.getPrototypeOf(values.editor), null);
	assert.deepEqual(JSON.parse(JSON.stringify(values)), { editor: { fontSize: 14, wordWrap: "on" } });
	assert.equal(getConfigurationValue<number>(values, "editor.fontSize"), 14);
	assert.equal(getConfigurationValue(values, "editor.missing", 20), 20);
	addToValueTree(values, "editor.minimap.enabled", true, message => conflicts.push(message));
	removeFromValueTree(values, "editor.wordWrap");
	merge(values, { editor: { fontSize: 16, lineNumbers: "on" } }, false);
	assert.deepEqual(JSON.parse(JSON.stringify(values)), { editor: { fontSize: 14, minimap: { enabled: true }, lineNumbers: "on" } });
	assert.deepEqual(conflicts, []);
	assert.equal(getLanguageTagSettingPlainKey("[javascript][typescript]"), "javascript, typescript");
});

test('configuration parser validates persisted JSONC independently of transport', () => {
	const parser = new ConfigurationModelParser('settings', new NullLoggerService());
	parser.parse('// keep comments\n{ "editor.fontSize": 14, "[typescript]": { "editor.fontSize": 16 }, }');
	assert.deepEqual(parser.errors, []);
	assert.equal(parser.configurationModel.getValue('editor.fontSize'), 14);
	assert.equal(parser.configurationModel.override('typescript').getValue('editor.fontSize'), 16);
	assert.throws(() => parser.parse('{ "__proto__.unsafe": true }'), /invalid configuration key/);
	assert.throws(() => parser.parse('[]'), /must be an object/);
	assert.throws(() => parser.parse('{"[typescript]": 2}'), /must be an object/);
	parser.parse('{');
	assert.ok(parser.errors.length > 0);
});

test('configuration parser preserves slash-containing keys in settings and language overrides', () => {
	const parser = new ConfigurationModelParser('settings', new NullLoggerService());
	parser.parse('{ "js/ts.tsdk.path": "./node_modules/typescript/lib", "[typescript]": { "js/ts.tsdk.path": "./custom/typescript/lib" } }');
	assert.deepEqual(parser.errors, []);
	assert.equal(parser.configurationModel.getValue('js/ts.tsdk.path'), './node_modules/typescript/lib');
	assert.equal(parser.configurationModel.override('typescript').getValue('js/ts.tsdk.path'), './custom/typescript/lib');
	assert.deepEqual(parser.configurationModel.getValue('js/ts'), { tsdk: { path: './node_modules/typescript/lib' } });
});

test('configuration registry accepts slash-containing typed keys', () => {
	const registry = new ConfigurationRegistry();
	const key = registry.registerConfiguration({ key: 'js/ts.tsdk.path', defaultValue: '', parse: value => String(value) });
	assert.equal(registry.getConfiguration(key)?.defaultValue, '');
	assert.throws(() => registry.registerConfiguration({ key: '__proto__.unsafe', defaultValue: true, parse: value => Boolean(value) }), /Invalid configuration key/);
});

test('workbench configuration reloads and edits slash-containing contributed settings', async () => {
	const key = 'js/ts.tsdk.path';
	const registry = new ConfigurationRegistry();
	registry.updateConfigurations({ add: [{ properties: { [key]: { type: 'string', default: '' } } }], remove: [] });
	const source = '// Keep the SDK explanation.\n{ "js/ts.tsdk.path": "./node_modules/typescript/lib", "editor.fontSize": 16, }\n';
	using files = new TestConfigurationFiles(source);
	using service = new WorkbenchConfigurationService({ files, registry });
	await service.reloadConfiguration();
	assert.equal(service.getValue(key), './node_modules/typescript/lib');
	await service.updateValue(key, './custom/typescript/lib');
	await service.reloadConfiguration();
	assert.equal(service.getValue(key), './custom/typescript/lib');
	const saved = (await service.read()).source;
	assert.match(saved, /Keep the SDK explanation/u);
	assert.match(saved, /"editor\.fontSize": 16/u);
	assert.match(saved, /"js\/ts\.tsdk\.path": "\.\/custom\/typescript\/lib"/u);
});

test("workbench configuration resolves typed defaults and live snapshots", async () => {
	const registry = new ConfigurationRegistry();
	const fontSize = registry.registerConfiguration({
		key: "editor.fontSize",
		defaultValue: 12,
		parse(value): number {
			if (!Number.isInteger(value) || (value as number) < 8) {
				throw new TypeError("font size must be an integer of at least 8");
			}
			return value as number;
		},
	});
	using api = new TestConfigurationFiles('{ "editor.fontSize": 16 }\n');
	using service = new WorkbenchConfigurationService({
		files: api,
		registry,
	});
	let changes = 0;
	using listener = service.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(fontSize)) changes += 1;
	});

	assert.equal(service.getValue<number>(fontSize), 12);
	await service.reloadConfiguration();
	assert.equal(service.getValue<number>(fontSize), 16);

	await service.updateValue(fontSize, 18);
	assert.equal(service.getValue<number>(fontSize), 18);

	await api.emit('{ "editor.fontSize": 20 }\n');
	await service.reloadConfiguration();
	assert.equal(service.getValue<number>(fontSize), 20);
	await service.updateValue(fontSize, undefined);
	assert.equal(service.getValue<number>(fontSize), 12);
	assert.equal(changes, 4);
	await assert.rejects(
		() => service.updateValue(fontSize, 4),
		/font size/,
	);
});

test('workbench configuration preserves editable JSONC source through file-service writes', async () => {
	const registry = new ConfigurationRegistry();
	const fontSize = registry.registerConfiguration({
		key: 'editor.fontSize', defaultValue: 12, parse(value): number {
			if (!Number.isInteger(value) || (value as number) < 8) throw new TypeError('font size must be at least 8');
			return value as number;
		}
	});
	using service = new WorkbenchConfigurationService({ registry });
	const initial = await service.read();
	const source = '{\n\t// Keep this user explanation.\n\t"editor.fontSize": 16,\n\t"extension.unregistered": true,\n}\n';
	const saved = await service.write(source);
	assert.equal(saved.source, source);
	assert.notEqual(saved.revision, initial.revision);
	assert.equal(service.getValue(fontSize), 16);
	await service.updateValue(fontSize, 18);
	assert.match((await service.read()).source, /Keep this user explanation/u);
	assert.match((await service.read()).source, /"editor\.fontSize": 18/u);
	await assert.rejects(service.write('{}', initial.revision), FileRevisionConflictError);
	await assert.rejects(service.write('[]'), /must be an object/);
	assert.equal(service.getValue(fontSize), 18);
});

test("workbench configuration applies and reports language overrides", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	using api = new TestConfigurationFiles('{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 8 } }\n');
	using service = new WorkbenchConfigurationService({ files: api, registry });
	const changes: Array<{ readonly keys: string[]; readonly overrides: [string, string[]][]; readonly typescript: boolean; readonly javascript: boolean; }> = [];
	using listener = service.onDidChangeConfiguration(event => changes.push({
		keys: event.change.keys,
		overrides: event.change.overrides,
		typescript: event.affectsConfiguration(tabSize, { overrideIdentifier: "typescript" }),
		javascript: event.affectsConfiguration(tabSize, { overrideIdentifier: "javascript" }),
	}));

	await service.reloadConfiguration();
	assert.equal(service.getValue<number>(tabSize), 2);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "typescript" }), 8);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "javascript" }), 2);

	await api.emit('{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 6 } }\n');
	await service.reloadConfiguration();
	assert.deepEqual(changes.at(-1), {
		keys: [],
		overrides: [["typescript", [tabSize]]],
		typescript: true,
		javascript: false,
	});
	await service.updateValue(tabSize, 10, { overrideIdentifier: "typescript" });
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "typescript" }), 10);
	assert.match((await service.read()).source, /"\[typescript\]"\s*:\s*\{\s*"editor\.tabSize"\s*:\s*10/u);
});

test("workbench configuration preserves combined override blocks in data and inspection", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	using api = new TestConfigurationFiles('{ "editor.tabSize": 2, "[typescript][javascript]": { "editor.tabSize": 8 } }\n');
	using service = new WorkbenchConfigurationService({ files: api, registry });
	await service.reloadConfiguration();

	assert.deepEqual(service.getConfigurationData().userLocal, {
		contents: {
			editor: { tabSize: 2 },
			"[typescript][javascript]": { "editor.tabSize": 8 },
		},
		keys: [tabSize, "[typescript][javascript]"],
		overrides: [{ identifiers: ["typescript", "javascript"], keys: [tabSize], contents: { editor: { tabSize: 8 } } }],
	});
	assert.deepEqual(service.keys().user, [tabSize, "[typescript][javascript]"]);
	assert.deepEqual(service.inspect<number>(tabSize, { overrideIdentifier: "typescript" }), {
		defaultValue: 4,
		userValue: 8,
		userLocalValue: 8,
		value: 8,
		default: { value: 4 },
		user: {
			value: 2,
			override: 8,
			overrides: [{ identifiers: ["typescript", "javascript"], value: 8 }],
		},
		userLocal: {
			value: 2,
			override: 8,
			overrides: [{ identifiers: ["typescript", "javascript"], value: 8 }],
		},
		overrideIdentifiers: ["typescript", "javascript"],
	});

	await service.updateValue(tabSize, 6, { overrideIdentifiers: ["javascript", "typescript", "javascript"] }, ConfigurationTarget.USER_LOCAL);
	assert.equal(service.getValue<number>(tabSize, { overrideIdentifier: "javascript" }), 6);
	assert.match((await service.read()).source, /"\[typescript\]\[javascript\]"\s*:\s*\{\s*"editor\.tabSize"\s*:\s*6/u);
	assert.doesNotMatch((await service.read()).source, /"\[javascript\]"\s*:/u);
	assert.doesNotMatch((await service.read()).source, /"\[typescript\]"\s*:/u);
});

test('workbench saved settings use the same language precedence for reads, inspection and change events', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'editor.tabSize', defaultValue: 4, parse: value => Number(value) });
	using service = new WorkbenchConfigurationService({ registry });
	await service.write('{ "editor.tabSize": 8, "[typescript]": { "editor.tabSize": 2 }, "[typescript][javascript]": { "editor.tabSize": 6 } }');
	assert.deepEqual([
		service.getValue('editor.tabSize'), service.getValue('editor.tabSize', { overrideIdentifier: 'typescript' }),
		service.getValue('editor.tabSize', { overrideIdentifier: 'javascript' }),
		service.inspect('editor.tabSize', { overrideIdentifier: 'typescript' }).userLocalValue,
	], [8, 2, 6, 2]);
	const events: { typescript: boolean; javascript: boolean; }[] = [];
	using listener = service.onDidChangeConfiguration(event => events.push({
		typescript: event.affectsConfiguration('editor.tabSize', { overrideIdentifier: 'typescript' }),
		javascript: event.affectsConfiguration('editor.tabSize', { overrideIdentifier: 'javascript' }),
	}));
	await service.updateValue('editor.tabSize', 3, { overrideIdentifier: 'typescript' });
	assert.deepEqual(events, [{ typescript: true, javascript: false }]);
	assert.equal(service.getValue('editor.tabSize', { overrideIdentifier: 'typescript' }), 3);
	assert.equal(service.getValue('editor.tabSize', { overrideIdentifier: 'javascript' }), 6);

	await service.updateValue('editor.tabSize', 10, { overrideIdentifiers: ['typescript', 'javascript'] });
	assert.deepEqual(events.at(-1), { typescript: false, javascript: true });
	assert.equal(service.getValue('editor.tabSize', { overrideIdentifier: 'typescript' }), 3);
	assert.equal(service.inspect('editor.tabSize', { overrideIdentifier: 'javascript' }).userLocalValue, 10);
});

test('workbench structured settings merge defaults, saved values and language values without changing prior events', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'editor.options', defaultValue: { colors: { foreground: 'gray', background: 'black' }, rulers: [80] },
		parse: value => value as { colors?: { foreground?: string; background?: string; }; rulers?: number[]; },
	});
	using service = new WorkbenchConfigurationService({ registry });
	await service.write('{ "editor.options": { "colors": { "foreground": "white" } }, "[typescript]": { "editor.options": { "rulers": [100] } } }');
	assert.deepEqual(service.getValue('editor.options', { overrideIdentifier: 'typescript' }), {
		colors: { foreground: 'white', background: 'black' }, rulers: [100],
	});
	assert.deepEqual(service.inspect('editor.options', { overrideIdentifier: 'typescript' }).userLocalValue, {
		colors: { foreground: 'white' }, rulers: [100],
	});
	const before = service.getConfigurationData();
	const events: import('../../common/configuration.js').IConfigurationChangeEvent[] = [];
	using listener = service.onDidChangeConfiguration(event => events.push(event));
	await service.updateValue('editor.options', { colors: { foreground: 'green' } });
	assert.equal(events[0]!.affectsConfiguration('editor.options.colors.foreground', { overrideIdentifier: 'typescript' }), true);
	assert.equal(events[0]!.affectsConfiguration('editor.options.rulers', { overrideIdentifier: 'typescript' }), false);
	await service.updateValue('editor.options', { colors: { foreground: 'green' }, rulers: [120] });
	assert.equal(events[0]!.affectsConfiguration('editor.options.colors.foreground', { overrideIdentifier: 'typescript' }), true);
	assert.deepEqual(before.userLocal.contents, {
		editor: { options: { colors: { foreground: 'white' } } }, '[typescript]': { 'editor.options': { rulers: [100] } },
	});
});

test("workbench configuration accepts resource reads and rejects unsupported write owners", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	using service = new WorkbenchConfigurationService({ registry });

	await service.updateValue(tabSize, 6, ConfigurationTarget.USER);
	assert.equal(service.getValue<number>(tabSize), 6);
	await assert.rejects(service.updateValue(tabSize, 8, ConfigurationTarget.WORKSPACE), /Unable to write editor\.tabSize to target 5/u);
	await assert.rejects(service.updateValue(tabSize, 8, 99 as ConfigurationTarget), /target is invalid/u);
	await assert.rejects(
		service.updateValue(tabSize, 8, { resource: URI.parse("file:///workspace/file.ts") }, ConfigurationTarget.USER_LOCAL),
		/does not support resource overrides/u,
	);
	assert.equal(service.getValue(tabSize, { resource: URI.parse("file:///workspace/file.ts") }), 6);
	assert.equal(service.getValue(tabSize, { resource: URI.parse("output:/window") }), 6);
	assert.equal(service.inspect(tabSize, { resource: URI.parse("output:/window") }).value, 6);
});

test("workbench configuration change compares values after language overrides", async () => {
	const registry = new ConfigurationRegistry();
	const tabSize = registry.registerConfiguration({
		key: "editor.tabSize",
		defaultValue: 4,
		parse(value): number {
			if (!Number.isInteger(value)) throw new TypeError("tab size must be an integer");
			return value as number;
		},
	});
	using api = new TestConfigurationFiles('{ "editor.tabSize": 2, "[typescript]": { "editor.tabSize": 8 } }\n');
	using service = new WorkbenchConfigurationService({ files: api, registry });
	await service.reloadConfiguration();
	let affectsTypeScript: boolean | undefined;
	let affectsJavaScript: boolean | undefined;
	using listener = service.onDidChangeConfiguration(event => {
		affectsTypeScript = event.affectsConfiguration(tabSize, { overrideIdentifier: "typescript" });
		affectsJavaScript = event.affectsConfiguration(tabSize, { overrideIdentifier: "javascript" });
	});

	await api.emit('{ "editor.tabSize": 6, "[typescript]": { "editor.tabSize": 8 } }\n');
	await service.reloadConfiguration();

	assert.equal(affectsTypeScript, false);
	assert.equal(affectsJavaScript, true);
});

test('configuration reload preserves the last valid model after invalid external JSONC', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'editor.fontSize', defaultValue: 12, parse: value => Number(value) });
	using files = new TestConfigurationFiles('{"editor.fontSize": 18}');
	using service = new WorkbenchConfigurationService({ files, registry });
	await service.reloadConfiguration();
	await files.emit('{');
	await assert.rejects(service.reloadConfiguration(), /invalid/i);
	assert.equal(service.getValue('editor.fontSize'), 18);
	await files.emit('{"editor.fontSize": 20}');
	await service.reloadConfiguration();
	assert.equal(service.getValue('editor.fontSize'), 20);
});

test('workbench configuration applies the startup snapshot before services choose window behavior', () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'window.menuStyle', defaultValue: 'inherit', parse: value => value });
	registry.registerConfiguration({ key: 'window.titleBarStyle', defaultValue: 'custom', parse: value => value });
	const snapshot = {
		revision: 3,
		document: { version: 1, source: '{ "window.titleBarStyle": "system" }' },
	};
	using service = new WorkbenchConfigurationService({ registry, files: new TestConfigurationFiles((snapshot).document.source), source: (snapshot).document.source });
	assert.equal(service.getValue('window.titleBarStyle'), 'system');
	assert.equal(service.getValue('window.menuStyle'), 'inherit');
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { ConfigurationScope, ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import type { IConfigurationApi } from '../../../../../platform/configuration/common/configurationIpc.js';
import { ConfigurationMainService } from '../../../../../platform/configuration/electron-main/configurationMainService.js';
import { WorkbenchConfigurationService } from '../../../../../workbench/services/configuration/browser/configurationService.js';
import { configurationSettingBinding, SettingModel } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../../../workbench/common/configuration.js';
import { builtinLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { ConfigurationService } from '../../browser/configurationService.js';

function createRegistry(): ConfigurationRegistry {
	const registry = new ConfigurationRegistry();
	for (const [key, readOnly] of [['editor.editable', false], ['editor.fixed', true]] as const) {
		registry.registerConfiguration({
			key, defaultValue: 'workbench', agentsWindow: { default: 'sessions', readOnly },
			scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
			parse(value: unknown): string {
				if (typeof value !== 'string') throw new TypeError('Expected text');
				return value;
			},
		});
	}
	return registry;
}

test('Sessions defaults, inspection and reset use the window default while ordinary Workbench keeps its default', async () => {
	const registry = createRegistry();
	using sessions = new ConfigurationService({ registry });
	using workbench = new WorkbenchConfigurationService({ registry });
	using model = new SettingModel(configurationSettingBinding(sessions, registry.getConfiguration('editor.editable')!));
	assert.deepEqual([sessions.getValue('editor'), workbench.getValue('editor'), model.state.defaultValue], [
		{ editable: 'sessions', fixed: 'sessions' }, { editable: 'workbench', fixed: 'workbench' }, 'sessions',
	]);
	assert.equal(sessions.inspect('editor.editable').default?.value, 'sessions');
	assert.deepEqual(sessions.getConfigurationData().defaults.contents, { editor: { editable: 'sessions', fixed: 'sessions' } });
	await model.update('workbench');
	assert.equal(model.state.isDefault, false);
	assert.equal(JSON.parse((await sessions.read()).source)['editor.editable'], 'workbench');
	await model.reset();
	assert.deepEqual([model.state.value, model.state.isDefault, JSON.parse((await sessions.read()).source)], ['sessions', true, {}]);
});

test('Sessions ignores fixed user and language values and rejects every typed write without changing the document', async () => {
	const registry = createRegistry();
	const source = '{ "editor.fixed": "user", "editor.editable": "user", "[typescript]": { "editor.fixed": "language", "editor.editable": "language" } }';
	using sessions = new ConfigurationService({ registry, initialSnapshot: { revision: 4, document: { version: 1, source } } });
	assert.deepEqual([
		sessions.getValue('editor'), sessions.getValue('editor', { overrideIdentifier: 'typescript' }),
		sessions.inspect('editor.fixed').userValue, sessions.inspect('editor.fixed', { overrideIdentifier: 'typescript' }).userValue,
	], [{ editable: 'user', fixed: 'sessions' }, { editable: 'language', fixed: 'sessions' }, undefined, undefined]);
	assert.deepEqual(sessions.getConfigurationData().userLocal.contents, { editor: { editable: 'user' }, '[typescript]': { 'editor.editable': 'language' } });
	await assert.rejects(sessions.updateValue('editor.fixed', 'new'), /read-only/);
	await assert.rejects(sessions.updateValue('editor.fixed', undefined), /read-only/);
	await assert.rejects(sessions.updateValue('editor.fixed', 'new', { overrideIdentifier: 'typescript' }, ConfigurationTarget.USER_LOCAL), /read-only/);
	assert.deepEqual(await sessions.read(), { source, revision: 4 });
});

test('Two windows share one persisted file and revisions while ignored edits emit only resource changes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-sessions-settings-'));
	let main: ConfigurationMainService | undefined;
	try {
		const filePath = join(directory, 'settings.json');
		main = await ConfigurationMainService.create({ filePath });
		const host = main;
		const api: IConfigurationApi = { read: async () => host.read(), update: request => host.update(request), onDidChange: listener => host.onDidChange(listener) };
		const registry = createRegistry();
		using sessions = new ConfigurationService({ registry, api, initialSnapshot: main.read() });
		using workbench = new WorkbenchConfigurationService({ registry, api, initialSnapshot: main.read() });
		const changes: string[][] = [];
		const resources: number[] = [];
		using changeListener = sessions.onDidChangeConfiguration(event => changes.push([...event.affectedKeys]));
		using resourceListener = sessions.onDidChangeResource(snapshot => resources.push(snapshot.revision));
		await workbench.updateValue('editor.fixed', 'ordinary');
		assert.deepEqual([sessions.getValue('editor.fixed'), workbench.getValue('editor.fixed'), changes, resources.length], ['sessions', 'ordinary', [], 1]);
		await sessions.updateValue('editor.editable', 'shared');
		assert.deepEqual([sessions.getValue('editor.editable'), workbench.getValue('editor.editable'), changes], ['shared', 'shared', [['editor.editable']]]);
		const source = '// shared file\n{ "editor.fixed": "file", "editor.editable": "external", "unrelated.key": true, "[typescript]": { "editor.fixed": "ignored" }, }\n';
		await sessions.write(source, (await sessions.read()).revision);
		assert.deepEqual([sessions.getValue('editor'), workbench.getValue('editor'), changes.at(-1)], [{ editable: 'external', fixed: 'sessions' }, { editable: 'external', fixed: 'file' }, ['editor.editable', 'unrelated.key']]);
		assert.equal(await readFile(filePath, 'utf8'), source);
		await assert.rejects(sessions.write('{}', 0), /revision conflict/i);
		const externalSource = source.replace('external', 'disk-edit');
		let resolveReload!: () => void;
		const reloaded = new Promise<void>(resolve => { resolveReload = resolve; });
		using fileListener = sessions.onDidChangeConfiguration(() => resolveReload());
		await writeFile(filePath, externalSource);
		await reloaded;
		assert.deepEqual([sessions.getValue('editor'), workbench.getValue('editor')], [{ editable: 'disk-edit', fixed: 'sessions' }, { editable: 'disk-edit', fixed: 'file' }]);
		await main.close();
		main = await ConfigurationMainService.create({ filePath });
		const restartedHost = main;
		const restartedApi: IConfigurationApi = { read: async () => restartedHost.read(), update: request => restartedHost.update(request), onDidChange: listener => restartedHost.onDidChange(listener) };
		using reopened = new ConfigurationService({ registry, api: restartedApi, initialSnapshot: main.read() });
		assert.deepEqual([reopened.getValue('editor'), (await reopened.read()).source], [{ editable: 'disk-edit', fixed: 'sessions' }, externalSource]);
	} finally {
		await main?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Production window settings keep Workbench values and report a localized Sessions write error', async () => {
	const source = JSON.stringify({ [WorkbenchConfiguration.windowTitle]: 'Custom', [WorkbenchConfiguration.sideBarLocation]: 'right', [WorkbenchConfiguration.activityBarLocation]: 'top', [WorkbenchConfiguration.activityBarCompact]: true });
	const initialSnapshot = { revision: 1, document: { version: 1 as const, source } };
	using sessions = new ConfigurationService({ initialSnapshot });
	using workbench = new WorkbenchConfigurationService({ initialSnapshot });
	assert.deepEqual([
		sessions.getValue(WorkbenchConfiguration.windowTitle), sessions.getValue(WorkbenchConfiguration.sideBarLocation), sessions.getValue(WorkbenchConfiguration.activityBarLocation), sessions.getValue(WorkbenchConfiguration.activityBarCompact),
		workbench.getValue(WorkbenchConfiguration.windowTitle), workbench.getValue(WorkbenchConfiguration.sideBarLocation), workbench.getValue(WorkbenchConfiguration.activityBarLocation), workbench.getValue(WorkbenchConfiguration.activityBarCompact),
	], ['${appName}', 'left', ActivityBarPosition.DEFAULT, false, 'Custom', 'right', ActivityBarPosition.TOP, true]);
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', chinese.bundles);
	try {
		await assert.rejects(sessions.updateValue(WorkbenchConfiguration.sideBarLocation, 'right'), { message: '设置 workbench.sideBar.location 在此窗口中为只读。' });
	} finally {
		resetNlsResolver();
	}
});

test('Registered Agents defaults are validated and invalid saved values resolve to the window default', () => {
	const registry = createRegistry();
	assert.throws(() => registry.registerConfiguration({ key: 'invalid.default', defaultValue: 'text', agentsWindow: { default: 7 as unknown as string }, parse: value => { if (typeof value !== 'string') throw new TypeError('Expected text'); return value; } }), /Expected text/);
	const errors: unknown[] = [];
	using sessions = new ConfigurationService({ registry, onError: error => errors.push(error), initialSnapshot: { revision: 1, document: { version: 1, source: '{ "editor.editable": 9 }' } } });
	assert.deepEqual([sessions.getValue('editor.editable'), errors.length], ['sessions', 1]);
});

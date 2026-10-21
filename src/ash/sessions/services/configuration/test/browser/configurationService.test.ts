import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { FileUserDataProvider } from '../../../../../platform/userData/common/fileUserDataProvider.js';
import { Schemas } from '../../../../../base/common/network.js';
import { FileRevisionConflictError } from '../../../../../platform/files/common/files.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { ConfigurationScope, ConfigurationRegistry, type IConfigurationNode } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService as WorkspaceService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { configurationSettingBinding, SettingModel } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../../../workbench/common/configuration.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { testConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { ConfigurationService as SessionsConfigurationService } from '../../browser/configurationService.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { PolicyValue } from '../../../../../base/common/policy.js';
import type { IPolicyService, PolicyDefinition } from '../../../../../platform/policy/common/policy.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { BrowserWorkingCopyService } from '../../../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import type { IWorkingCopy } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';

const ConfigurationService = testConfigurationService(SessionsConfigurationService);

class TestPolicyService implements IPolicyService {
	readonly _serviceBrand = undefined;
	readonly changes = new Emitter<readonly string[]>();
	readonly onDidChange = this.changes.event;
	policyDefinitions: Record<string, PolicyDefinition> = {};
	readonly values = new Map<string, PolicyValue>();
	async updatePolicyDefinitions(definitions: Record<string, PolicyDefinition>): Promise<Record<string, PolicyValue>> {
		this.policyDefinitions = definitions;
		return Object.fromEntries(this.values);
	}
	getPolicyValue(name: string): PolicyValue | undefined { return this.values.get(name); }
}

async function createLayeredConfiguration(policies?: IPolicyService, fileService = new FileService(), fileProvider = new InMemoryFileSystemProvider()) {
	const disposables = new DisposableStore();
	try {
		const provider = disposables.add(fileProvider);
		const files = disposables.add(fileService);
		disposables.add(files.registerProvider('file', provider));
		const identities = disposables.add(new TestUriIdentityServices(files));
		const workingCopies = disposables.add(identities.createInstance(BrowserWorkingCopyService));
		const roots = [URI.file('/one'), URI.file('/two')];
		const workspaceFile = URI.file('/project/example.code-workspace');
		const folderFiles = roots.map(root => URI.joinPath(root, '.vscode', 'settings.json'));
		const write = async (resource: URI, content: string): Promise<void> => {
			await files.createDirectory(resource.with({ path: resource.path.slice(0, resource.path.lastIndexOf('/')) }));
			await files.writeFile({ resource, content }, { create: true, overwrite: true });
		};
		await write(workspaceFile, '// workspace\n{ "folders": [], "settings": { // keep settings\n"editor.layer": "workspace", "[typescript]": { // keep language\n"editor.layer": "workspace-ts" }, "editor.fixed": "ignored", "application.layer": "ignored" }, "unrelated": true }');
		await write(folderFiles[0]!, '{ "editor.layer": "folder", "[typescript]": { "editor.layer": "folder-ts" }, "application.layer": "ignored", "window.layer": "ignored" }');
		await write(folderFiles[1]!, '{ "editor.layer": "other" }');
		const registry = new ConfigurationRegistry();
		for (const [key, scope] of [['editor.layer', ConfigurationScope.LANGUAGE_OVERRIDABLE], ['application.layer', ConfigurationScope.APPLICATION], ['window.layer', ConfigurationScope.WINDOW]] as const) {
			registry.registerConfiguration({
				key, defaultValue: 'default', scope, policy: key === 'editor.layer' ? { name: 'EditorLayer' } : undefined, parse: value => {
					if (typeof value !== 'string') throw new TypeError('Expected string');
					return value;
				}
			});
		}
		registry.registerConfiguration({ key: 'editor.fixed', defaultValue: 'default', agentsWindow: { default: 'fixed', readOnly: true }, scope: ConfigurationScope.RESOURCE, parse: value => String(value) });
		const errors: unknown[] = [];
		const configuration = disposables.add(new ConfigurationService({
			workspace: { id: 'multi', configuration: workspaceFile, folders: roots.map((uri, index) => ({ uri, id: String(index), name: String(index), index })) },
			registry,
			onError: error => errors.push(error),
			source: '{ "editor.layer": "user", "[typescript]": { "editor.layer": "user-ts" } }',
		}));
		await configuration.initialize(files, policies, workingCopies);
		return { disposables, provider, files, roots, folderFiles, workspaceFile, workspace: configuration, configuration, registry, errors, write, workingCopies };
	} catch (error) { disposables.dispose(); throw error; }
}

test('Workspace and folder layers resolve resource and language precedence, scopes and inspection', async () => {
	const host = await createLayeredConfiguration();
	using cleanup = host.disposables;
	const { configuration, roots } = host;
	const overrides = { resource: URI.joinPath(roots[0]!, 'main.ts'), overrideIdentifier: 'typescript' };
	assert.deepEqual([
		configuration.getValue('editor.layer'), configuration.getValue('editor.layer', { resource: roots[0] }),
		configuration.getValue('editor.layer', { resource: roots[1] }), configuration.getValue('editor.layer', overrides),
		configuration.getValue('application.layer', overrides), configuration.getValue('window.layer', overrides), configuration.getValue('editor.fixed', overrides),
	], ['workspace', 'folder', 'other', 'folder-ts', 'default', 'default', 'fixed']);
	const inspected = configuration.inspect('editor.layer', overrides);
	assert.deepEqual([inspected.defaultValue, inspected.userValue, inspected.workspaceValue, inspected.workspaceFolderValue, inspected.value], ['default', 'user-ts', 'workspace-ts', 'folder-ts', 'folder-ts']);
	assert.deepEqual(configuration.getConfigurationData().folders.map(([uri]) => URI.revive(uri).path), ['/one', '/two']);
	assert.deepEqual(configuration.keys().workspace, ['editor.layer', '[typescript]']);
	await assert.rejects(configuration.updateValue('application.layer', 'new', ConfigurationTarget.WORKSPACE), /cannot be written/);
	await assert.rejects(configuration.updateValue('window.layer', 'new', { resource: roots[0] }, ConfigurationTarget.WORKSPACE_FOLDER), /cannot be written/);
});

test('Workspace writes preserve nested JSONC, target inference and combined language blocks', async () => {
	const host = await createLayeredConfiguration();
	using cleanup = host.disposables;
	const { configuration, files, workspaceFile, folderFiles, roots } = host;
	await configuration.updateValue('editor.layer', 'changed');
	assert.equal(configuration.inspect('editor.layer').workspaceValue, 'changed');
	assert.equal(JSON.parse((await configuration.read()).source)['editor.layer'], 'user');
	await configuration.updateValue('editor.layer', 'changed-ts', { overrideIdentifier: 'typescript' }, ConfigurationTarget.WORKSPACE);
	const source = (await files.readFile(workspaceFile)).content;
	assert.ok(source.includes('// workspace') && source.includes('// keep settings') && source.includes('// keep language'));
	assert.ok(source.includes('"unrelated": true'));
	await configuration.updateValue('editor.layer', 'changed-folder', { resource: roots[0] });
	assert.equal(configuration.inspect('editor.layer', { resource: roots[0] }).workspaceFolderValue, 'changed-folder');
	assert.ok((await files.readFile(folderFiles[0]!)).content.includes('changed-folder'));
	await configuration.updateValue('editor.layer', undefined, { resource: roots[0] });
	assert.deepEqual([configuration.inspect('editor.layer', { resource: roots[0] }).userValue, configuration.inspect('editor.layer').workspaceValue, configuration.inspect('editor.layer', { resource: roots[0] }).workspaceFolderValue], [undefined, undefined, undefined]);
});

test('External folder edits emit resource-aware changes and invalid JSONC retains the last valid layer', async () => {
	const host = await createLayeredConfiguration();
	using cleanup = host.disposables;
	const { configuration, roots, folderFiles, write, errors } = host;
	let changed!: () => void;
	const event = new Promise<void>(resolve => { changed = resolve; });
	using listener = configuration.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration('editor.layer', { resource: roots[0] })) return;
		assert.equal(event.source, ConfigurationTarget.WORKSPACE_FOLDER);
		assert.equal(event.affectsConfiguration('editor.layer', { resource: roots[1] }), false);
		changed();
	});
	await write(folderFiles[0]!, '{ "editor.layer": "external" }');
	await event;
	assert.equal(configuration.getValue('editor.layer', { resource: roots[0] }), 'external');
	await write(folderFiles[0]!, '{ broken');
	await assert.rejects(configuration.reloadConfiguration(ConfigurationTarget.WORKSPACE_FOLDER), /JSONC|configuration|object|source/);
	assert.equal(configuration.getValue('editor.layer', { resource: roots[0] }), 'external');
	assert.ok(errors.length > 0);
	await write(folderFiles[0]!, '{}');
	await configuration.reloadConfiguration(ConfigurationTarget.WORKSPACE_FOLDER);
	assert.equal(configuration.getValue('editor.layer', { resource: roots[0] }), 'workspace');
});

test('Workspace switching removes old folder layers and single-folder writes use its settings file', async () => {
	const host = await createLayeredConfiguration();
	using cleanup = host.disposables;
	const { configuration, workspace, roots, folderFiles, write } = host;
	workspace.updateWorkspace({ id: 'single', uri: roots[1]! });
	await configuration.reloadConfiguration();
	assert.deepEqual([configuration.getValue('editor.layer'), configuration.getConfigurationData().folders.length], ['other', 0]);
	await configuration.updateValue('editor.layer', 'single-written', ConfigurationTarget.WORKSPACE);
	assert.ok((await host.files.readFile(folderFiles[1]!)).content.includes('single-written'));
	await write(folderFiles[0]!, '{ "editor.layer": "retired" }');
	await configuration.reloadConfiguration();
	assert.equal(configuration.getValue('editor.layer'), 'single-written');
	workspace.updateWorkspace({ id: 'empty' });
	await configuration.reloadConfiguration();
	assert.equal(configuration.getValue('editor.layer'), 'user');
	await assert.rejects(configuration.updateValue('editor.layer', 'new', ConfigurationTarget.WORKSPACE), /No settings resource/);
});

test('Policy overrides user, workspace, folder and language values, blocks writes and restores inheritance on removal', async () => {
	const policies = new TestPolicyService();
	using policyCleanup = policies.changes;
	policies.values.set('EditorLayer', 'managed');
	const host = await createLayeredConfiguration(policies);
	using cleanup = host.disposables;
	const { configuration, roots } = host;
	const overrides = { resource: roots[0], overrideIdentifier: 'typescript' };
	const binding = configurationSettingBinding(configuration, host.registry.getConfiguration('editor.layer')!, overrides, ConfigurationTarget.WORKSPACE_FOLDER);
	assert.equal(binding.getValue(), 'managed', 'the Settings control displays policy above the selected layer');
	assert.deepEqual([configuration.getValue('editor.layer', overrides), configuration.inspect('editor.layer', overrides).policyValue, configuration.keys().policy], ['managed', 'managed', ['editor.layer']]);
	assert.deepEqual(policies.policyDefinitions, { EditorLayer: { type: 'string' } });
	await assert.rejects(configuration.updateValue('editor.layer', 'new', overrides, ConfigurationTarget.WORKSPACE_FOLDER), /administrator policy/);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', chinese.bundles);
	try { await assert.rejects(configuration.updateValue('editor.layer', undefined), { message: '设置 editor.layer 由管理员策略控制。' }); }
	finally { resetNlsResolver(); }
	policies.values.set('EditorLayer', false);
	policies.changes.fire(['EditorLayer']);
	assert.equal(configuration.getValue('editor.layer', overrides), 'managed');
	assert.ok(host.errors.length > 0);
	await assert.rejects(configuration.updateValue('editor.layer', 'invalid-policy-bypass'), /administrator policy/);
	policies.values.delete('EditorLayer');
	policies.changes.fire(['EditorLayer']);
	assert.deepEqual([configuration.getValue('editor.layer', overrides), configuration.inspect('editor.layer').policyValue], ['folder-ts', undefined]);
	assert.equal(binding.getValue(), 'folder-ts');
	await configuration.updateValue('editor.layer', 'unlocked', overrides, ConfigurationTarget.WORKSPACE_FOLDER);
	assert.equal(configuration.getValue('editor.layer', overrides), 'unlocked');
});

test('A late read from a retired workspace cannot replace the selected workspace configuration', async () => {
	let release!: () => void;
	let started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	class DeferredFileService extends FileService {
		hold = false;
		override async readFile(...args: Parameters<FileService['readFile']>) {
			const result = await super.readFile(...args);
			if (this.hold && args[0].path === '/one/.vscode/settings.json') { started(); await gate; }
			return result;
		}
	}
	const files = new DeferredFileService();
	const host = await createLayeredConfiguration(undefined, files);
	using cleanup = host.disposables;
	files.hold = true;
	const loading = host.configuration.reloadConfiguration(ConfigurationTarget.WORKSPACE_FOLDER);
	await entered;
	host.workspace.updateWorkspace({ id: 'new', uri: host.roots[1]! });
	try {
		await host.configuration.reloadConfiguration();
		assert.equal(host.configuration.getValue('editor.layer'), 'other');
	} finally { release(); }
	await loading;
	assert.equal(host.configuration.getValue('editor.layer'), 'other');
});

test('A retired workspace load cannot report a revoked-file error against its replacement', async () => {
	let release!: () => void;
	let started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	class DeferredFileService extends FileService {
		hold = false;
		override async readFile(...args: Parameters<FileService['readFile']>) {
			if (this.hold && args[0].path === '/project/example.code-workspace') {
				started();
				await gate;
				throw new Error('The host revoked access to the previous workspace file');
			}
			return super.readFile(...args);
		}
	}
	const files = new DeferredFileService();
	const host = await createLayeredConfiguration(undefined, files);
	using cleanup = host.disposables;
	files.hold = true;
	host.configuration.updateWorkspace({ ...host.configuration.getWorkspace(), name: 'Retiring' });
	const loading = host.configuration.reloadConfiguration();
	try {
		await entered;
		host.configuration.updateWorkspace({ id: 'replacement', uri: host.roots[1]! });
		await host.configuration.reloadConfiguration();
	} finally { release(); }
	await loading;
	assert.equal(host.configuration.getValue('editor.layer'), 'other');
	assert.deepEqual(host.errors, []);
});

test('A host-cancelled configuration load is silent while Renderer still displays the previous workspace', async () => {
	let release!: () => void;
	let started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	class DeferredFileService extends FileService {
		hold = false;
		override async readFile(...args: Parameters<FileService['readFile']>) {
			if (this.hold && args[0].path === '/project/example.code-workspace') {
				this.hold = false;
				started();
				await gate;
				throw new CancellationError();
			}
			return super.readFile(...args);
		}
	}
	const files = new DeferredFileService();
	const host = await createLayeredConfiguration(undefined, files);
	using cleanup = host.disposables;
	files.hold = true;
	host.configuration.updateWorkspace({ ...host.configuration.getWorkspace(), name: 'Replacing' });
	const loading = host.configuration.reloadConfiguration();
	await entered;
	release();
	await loading;
	assert.deepEqual(host.errors, []);
});

test('Conditional folder writes reject a concurrent file revision and retain the external edit', async () => {
	class ConflictingProvider extends InMemoryFileSystemProvider {
		conflict = false;
		override async writeFile(...args: Parameters<InMemoryFileSystemProvider['writeFile']>) {
			if (this.conflict && args[2].expectedRevision !== undefined) {
				this.conflict = false;
				await super.writeFile(args[0], new TextEncoder().encode('{ "editor.layer": "external winner" }'), { create: false, overwrite: true });
			}
			return super.writeFile(...args);
		}
	}
	const provider = new ConflictingProvider();
	const host = await createLayeredConfiguration(undefined, new FileService(), provider);
	using cleanup = host.disposables;
	provider.conflict = true;
	await assert.rejects(host.configuration.updateValue('editor.layer', 'loser', { resource: host.roots[0] }, ConfigurationTarget.WORKSPACE_FOLDER), /revision/i);
	await host.configuration.reloadConfiguration(ConfigurationTarget.WORKSPACE_FOLDER);
	assert.equal(host.configuration.getValue('editor.layer', { resource: host.roots[0] }), 'external winner');
});

test('Policy notifications during definition registration survive initialization and setting withdrawal', async () => {
	class ChangingPolicyService extends TestPolicyService {
		override async updatePolicyDefinitions(definitions: Record<string, PolicyDefinition>): Promise<Record<string, PolicyValue>> {
			const old = await super.updatePolicyDefinitions(definitions);
			this.values.set('EditorLayer', 'arrived during registration');
			this.changes.fire(['EditorLayer']);
			return old;
		}
	}
	const policies = new ChangingPolicyService();
	using policyCleanup = policies.changes;
	const host = await createLayeredConfiguration(policies);
	using cleanup = host.disposables;
	assert.equal(host.configuration.getValue('editor.layer'), 'arrived during registration');
	const node: IConfigurationNode = { properties: { 'editor.extra': { type: 'string', default: 'initial', policy: { name: 'ExtraPolicy' } } } };
	host.registry.updateConfigurations({ add: [node], remove: [] });
	policies.values.set('ExtraPolicy', 'managed extra');
	policies.changes.fire(['ExtraPolicy']);
	assert.equal(host.configuration.getValue('editor.extra'), 'managed extra');
	host.registry.updateConfigurations({ add: [], remove: [node] });
	policies.changes.fire(['ExtraPolicy']);
	assert.equal(host.configuration.getValue('editor.extra'), undefined);
	assert.deepEqual(host.configuration.keys().policy, ['editor.layer']);
});

test('Settings writes protect dirty working copies and explicit save retains unrelated editor changes', async () => {
	const host = await createLayeredConfiguration();
	using cleanup = host.disposables;
	let dirty = true;
	const edited = '{ "folders": [], "settings": { "editor.layer": "edited" }, "editorUnrelated": true }';
	const copy: IWorkingCopy = {
		resource: host.workspaceFile, backupKind: 'text', get isDirty() { return dirty; }, hasExternalChange: false,
		onDidChangeDirty: Event.None, onDidChangeExternalChange: Event.None, onDidChangeContent: Event.None,
		backup: () => edited, restoreBackup: () => { }, dispose: () => { }, [Symbol.dispose]: () => { },
		save: async () => { await host.write(host.workspaceFile, edited); dirty = false; },
		saveAs: async () => { throw new Error('Unexpected Save As'); },
		revert: async () => { dirty = false; },
	};
	using registration = host.workingCopies.register(copy);
	const original = (await host.files.readFile(host.workspaceFile)).content;
	await assert.rejects(host.configuration.updateValue('editor.layer', 'new', ConfigurationTarget.WORKSPACE), /unsaved changes/);
	assert.equal((await host.files.readFile(host.workspaceFile)).content, original);
	assert.equal(dirty, true);
	await host.configuration.updateValue('editor.layer', 'new', {}, ConfigurationTarget.WORKSPACE, { handleDirtyFile: 'save' });
	assert.deepEqual(JSON.parse((await host.files.readFile(host.workspaceFile)).content), { folders: [], settings: { 'editor.layer': 'new' }, editorUnrelated: true });
	assert.equal(dirty, false);
});

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

test('Late contributions apply current Sessions defaults and read-only rules across extension reloads', async () => {
	const registry = new ConfigurationRegistry();
	const source = '{ "editor.dynamic": "user", "[typescript]": { "editor.dynamic": "language" } }';
	using sessions = new ConfigurationService({ registry, source: source });
	using workbench = new WorkspaceService({ registry, source: source });
	const changes: ConfigurationTarget[] = [];
	using listener = sessions.onDidChangeConfiguration(event => {
		assert.equal(event.affectsConfiguration('editor.dynamic'), true);
		changes.push(event.source);
	});
	const fixed: IConfigurationNode = {
		properties: {
			'editor.dynamic': { type: 'string', default: 'workbench', scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, agentsWindow: { default: 'sessions', readOnly: true } },
		},
	};
	registry.updateConfigurations({ add: [fixed], remove: [] });
	assert.deepEqual([
		sessions.getValue('editor.dynamic'), sessions.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
		sessions.inspect('editor.dynamic').defaultValue, sessions.inspect('editor.dynamic').userValue,
		workbench.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
	], ['sessions', 'sessions', 'sessions', undefined, 'language']);
	await assert.rejects(sessions.updateValue('editor.dynamic', 'changed'), /read-only/);
	await assert.rejects(sessions.updateValue('editor.dynamic', 'changed', { overrideIdentifier: 'typescript' }), /read-only/);
	assert.equal((await sessions.read()).source, source);

	const editable: IConfigurationNode = {
		properties: {
			'editor.dynamic': { type: 'string', default: 'workbench', scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, agentsWindow: { default: 'new sessions' } },
		},
	};
	registry.updateConfigurations({ add: [editable], remove: [fixed] });
	assert.deepEqual([
		sessions.inspect('editor.dynamic').defaultValue, sessions.getValue('editor.dynamic'),
		sessions.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
	], ['new sessions', 'user', 'language']);
	await sessions.updateValue('editor.dynamic', 'changed', { overrideIdentifier: 'typescript' });
	assert.equal(sessions.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }), 'changed');
	registry.updateConfigurations({ add: [], remove: [editable] });
	// Unregistration removes the schema and window rules, not the user's stored values.
	assert.deepEqual([
		sessions.getValue('editor.dynamic'), sessions.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
		workbench.getValue('editor.dynamic'), workbench.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
	], ['user', 'changed', 'user', 'language']);
	assert.deepEqual(sessions.getConfigurationData().defaults.contents, {});
	await assert.rejects(sessions.updateValue('editor.dynamic', 'unregistered'), /Unknown configuration key/);
	registry.updateConfigurations({ add: [fixed], remove: [] });
	assert.deepEqual([
		sessions.getValue('editor.dynamic'), sessions.getValue('editor.dynamic', { overrideIdentifier: 'typescript' }),
	], ['sessions', 'sessions']);
	await assert.rejects(sessions.updateValue('editor.dynamic', 'read-only again'), /read-only/);
	assert.deepEqual(JSON.parse((await sessions.read()).source), { 'editor.dynamic': 'user', '[typescript]': { 'editor.dynamic': 'changed' } });
	assert.deepEqual(changes, [ConfigurationTarget.DEFAULT, ConfigurationTarget.DEFAULT, ConfigurationTarget.USER_LOCAL, ConfigurationTarget.DEFAULT, ConfigurationTarget.DEFAULT]);
});

test('Late typed registrations use Sessions defaults while invalid contribution defaults leave the registry unchanged', () => {
	const registry = new ConfigurationRegistry();
	using sessions = new ConfigurationService({ registry });
	registry.registerConfiguration({
		key: 'editor.late', defaultValue: false, agentsWindow: { default: true, readOnly: true }, parse: value => {
			if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
			return value;
		}
	});
	assert.equal(sessions.getValue('editor.late'), true);
	assert.throws(() => registry.updateConfigurations({
		add: [{
			properties: {
				'editor.invalid': { type: 'boolean', default: false, agentsWindow: { default: 'invalid' } },
			}
		}], remove: []
	}), /declared schema/);
	assert.deepEqual(registry.getConfigurations(), ['editor.late']);
	assert.deepEqual(sessions.getConfigurationData().defaults.contents, { editor: { late: true } });
});

test('Sessions defaults, inspection and reset use the window default while ordinary Workbench keeps its default', async () => {
	const registry = createRegistry();
	using sessions = new ConfigurationService({ registry });
	using workbench = new WorkspaceService({ registry });
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
	using sessions = new ConfigurationService({ registry, source: source });
	assert.deepEqual([
		sessions.getValue('editor'), sessions.getValue('editor', { overrideIdentifier: 'typescript' }),
		sessions.inspect('editor.fixed').userValue, sessions.inspect('editor.fixed', { overrideIdentifier: 'typescript' }).userValue,
	], [{ editable: 'user', fixed: 'sessions' }, { editable: 'language', fixed: 'sessions' }, undefined, undefined]);
	assert.deepEqual(sessions.getConfigurationData().userLocal.contents, { editor: { editable: 'user' }, '[typescript]': { 'editor.editable': 'language' } });
	await assert.rejects(sessions.updateValue('editor.fixed', 'new'), /read-only/);
	await assert.rejects(sessions.updateValue('editor.fixed', undefined), /read-only/);
	await assert.rejects(sessions.updateValue('editor.fixed', 'new', { overrideIdentifier: 'typescript' }, ConfigurationTarget.USER_LOCAL), /read-only/);
	assert.equal((await sessions.read()).source, source);
});

test('Two windows share the profile file while ignored settings still notify file observers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-sessions-settings-'));
	try {
		using disk = new DiskFileSystemProvider([URI.file(directory)]);
		using provider = new FileUserDataProvider(disk, URI.file(directory));
		using files = new FileService();
		using registration = files.registerProvider(Schemas.vscodeUserData, provider);
		const registry = createRegistry();
		using sessions = new ConfigurationService({ registry, files });
		using workbench = new WorkspaceService({ registry, files });
		const changes: string[][] = [];
		let fileChanges = 0;
		using changed = sessions.onDidChangeConfiguration(event => changes.push([...event.affectedKeys]));
		using fileChanged = files.onDidChangeFiles(() => fileChanges++);
		await workbench.updateValue('editor.fixed', 'ordinary');
		await sessions.reloadConfiguration();
		assert.deepEqual([sessions.getValue('editor.fixed'), workbench.getValue('editor.fixed'), changes], ['sessions', 'ordinary', []]);
		assert.ok(fileChanges > 0);
		const stale = (await sessions.read()).revision;
		await sessions.updateValue('editor.editable', 'shared');
		await workbench.reloadConfiguration();
		assert.deepEqual([sessions.getValue('editor.editable'), workbench.getValue('editor.editable')], ['shared', 'shared']);
		const source = '// shared file\n{ "editor.fixed": "file", "editor.editable": "external", "unrelated.key": true, "[typescript]": { "editor.fixed": "ignored" }, }\n';
		await sessions.write(source);
		await workbench.reloadConfiguration();
		assert.deepEqual([sessions.getValue('editor'), workbench.getValue('editor')], [{ editable: 'external', fixed: 'sessions' }, { editable: 'external', fixed: 'file' }]);
		assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), source);
		await assert.rejects(sessions.write('{}', stale), FileRevisionConflictError);
		let resolveReload!: () => void;
		const reloaded = new Promise<void>(resolve => { resolveReload = resolve; });
		using listener = sessions.onDidChangeConfiguration(() => resolveReload());
		await writeFile(join(directory, 'settings.json'), source.replace('external', 'disk-edit'));
		await reloaded;
		await workbench.reloadConfiguration();
		assert.equal(workbench.getValue('editor.editable'), 'disk-edit');
		using restarted = new ConfigurationService({ registry, files });
		await restarted.reloadConfiguration();
		assert.deepEqual(restarted.getValue('editor'), { editable: 'disk-edit', fixed: 'sessions' });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('Production window settings keep Workbench values and report a localized Sessions write error', async () => {
	const source = JSON.stringify({ [WorkbenchConfiguration.windowTitle]: 'Custom', [WorkbenchConfiguration.sideBarLocation]: 'right', [WorkbenchConfiguration.activityBarLocation]: 'top', [WorkbenchConfiguration.activityBarCompact]: true, [WorkbenchConfiguration.activityBarAutoHide]: true });
	const initialSnapshot = { revision: 1, document: { version: 1 as const, source } };
	using sessions = new ConfigurationService({ source });
	using workbench = new WorkspaceService({ source });
	assert.deepEqual([
		sessions.getValue(WorkbenchConfiguration.windowTitle), sessions.getValue(WorkbenchConfiguration.sideBarLocation), sessions.getValue(WorkbenchConfiguration.activityBarLocation), sessions.getValue(WorkbenchConfiguration.activityBarCompact),
		workbench.getValue(WorkbenchConfiguration.windowTitle), workbench.getValue(WorkbenchConfiguration.sideBarLocation), workbench.getValue(WorkbenchConfiguration.activityBarLocation), workbench.getValue(WorkbenchConfiguration.activityBarCompact),
	], ['${appName}', 'left', ActivityBarPosition.DEFAULT, false, 'Custom', 'right', ActivityBarPosition.TOP, true]);
	assert.deepEqual([sessions.getValue(WorkbenchConfiguration.activityBarAutoHide), workbench.getValue(WorkbenchConfiguration.activityBarAutoHide)], [false, true]);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', chinese.bundles);
	try {
		await assert.rejects(sessions.updateValue(WorkbenchConfiguration.sideBarLocation, 'right'), { message: '设置 workbench.sideBar.location 在此窗口中为只读。' });
		await assert.rejects(sessions.updateValue(WorkbenchConfiguration.activityBarAutoHide, true), { message: '设置 workbench.activityBar.autoHide 在此窗口中为只读。' });
	} finally {
		resetNlsResolver();
	}
});

test('Registered Agents defaults are validated and invalid saved values resolve to the window default', () => {
	const registry = createRegistry();
	assert.throws(() => registry.registerConfiguration({ key: 'invalid.default', defaultValue: 'text', agentsWindow: { default: 7 as unknown as string }, parse: value => { if (typeof value !== 'string') throw new TypeError('Expected text'); return value; } }), /Expected text/);
	const errors: unknown[] = [];
	using sessions = new ConfigurationService({ registry, onError: error => errors.push(error), source: '{ "editor.editable": 9 }' });
	assert.deepEqual([sessions.getValue('editor.editable'), errors.length], ['sessions', 1]);
});

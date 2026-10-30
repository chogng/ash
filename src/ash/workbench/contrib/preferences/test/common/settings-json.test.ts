import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { emptyEditorGroupsService } from '../../../../test/common/testWorkbenchContextKeys.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { PreferencesContribution } from '../../common/preferencesContribution.js';
import { UserDataProfileService } from '../../../../services/userDataProfile/browser/userDataProfileService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationFiles } from '../../../../services/configuration/test/common/testServices.js';
import type { ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import '../../../codeEditor/common/editorConfiguration.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { Extensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IEditorService as EditorServiceId } from '../../../../services/editor/common/editorService.js';
import { IFileTextModelService, TextModelConflictError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { Event } from '../../../../../base/common/event.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { URI } from '../../../../../base/common/uri.js';
import { ConfigurationRegistry, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationSchemaId, createConfigurationSchema } from '../../../../../platform/configuration/common/configurationSchema.js';
import { FileRevisionConflictError } from '../../../../../platform/files/common/files.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { BrowserTextResourceStore } from '../../../../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import type { EditorOpenOptions, EditorOpenTarget, IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { PreferencesService } from '../../../../../workbench/services/preferences/browser/preferencesService.js';
import type { IOpenSettingsOptions } from '../../../../../workbench/services/preferences/common/preferences.js';
import { configurationSettingBinding, SettingModel } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { createSettingsEditorInput, SettingsEditorInput, UserSettingsResource } from '../../../../../workbench/services/preferences/common/settingsEditorInput.js';
import { createJsonCompletionProvider } from '../../../../../../../test/fixtures/jsonLanguageFeatures.js';
import { SmartSnippetInserter } from '../../../../../workbench/contrib/preferences/common/smartSnippetInserter.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

const keybindingProfile = new KeybindingTestServices();
suiteTeardown(() => keybindingProfile.dispose());

test('Reset removes explicitly saved scalar and structured defaults while preserving unrelated JSONC', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'editor.fontSize', defaultValue: 14, parse: value => Number(value) });
	registry.registerConfiguration({ key: 'workbench.colors', defaultValue: {}, parse: value => value as Record<string, unknown> });
	using configuration = new WorkbenchConfigurationService({ registry });
	await configuration.write('{\n\t// Keep unrelated settings.\n\t"editor.fontSize": 14,\n\t"workbench.colors": {},\n\t"extension.data": 99,\n}\n');

	for (const key of ['editor.fontSize', 'workbench.colors']) {
		using model = new SettingModel(configurationSettingBinding(configuration, registry.getConfiguration(key)!));
		assert.deepEqual([model.isDefault(), model.state.isDefault], [false, false]);
		await model.reset();
		assert.deepEqual([model.isDefault(), model.state.isDefault, configuration.inspect(key).userLocalValue], [true, true, undefined]);
	}
	assert.match((await configuration.read()).source, /Keep unrelated settings/u);
	assert.match((await configuration.read()).source, /"extension.data": 99/u);
});

test('SettingModel announces explicit user overrides when the value stays at the default', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'status.flag', defaultValue: true, parse: value => value as boolean, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE });
	const registered = registry.getConfiguration('status.flag') as IRegisteredConfiguration<boolean>;
	using configuration = new WorkbenchConfigurationService({ registry });
	using model = new SettingModel(configurationSettingBinding(configuration, registered));
	const states: { value: boolean; isDefault: boolean; isPending: boolean; }[] = [];
	using listener = model.onDidChange(state => states.push({ value: state.value, isDefault: state.isDefault, isPending: state.isPending }));

	await configuration.write('{ "status.flag": true }');
	assert.deepEqual(states, [{ value: true, isDefault: false, isPending: false }]);
	model.refresh();
	await configuration.write('{ "status.flag": true }');
	assert.equal(states.length, 1, 'unchanged snapshots do not repeat the configured notification');
	await configuration.write('{ "[typescript]": { "status.flag": false } }');
	assert.deepEqual(states, [
		{ value: true, isDefault: false, isPending: false },
		{ value: true, isDefault: true, isPending: false },
	]);
	await configuration.write('{ "[typescript]": { "status.flag": true } }');
	assert.equal(states.length, 2, 'language-only changes do not configure the base setting');
	await configuration.updateValue('status.flag', false);
	assert.deepEqual(states.at(-1), { value: false, isDefault: false, isPending: false });
	await model.reset();
	assert.deepEqual(states.at(-1), { value: true, isDefault: true, isPending: false });
	assert.equal(configuration.inspect('status.flag').userLocalValue, undefined);
	assert.equal(configuration.inspect('status.flag', { overrideIdentifier: 'typescript' }).userLocalValue, true);
});

test('SettingModel keeps the configured status when the persistence layer rejects a reset', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'status.flag', defaultValue: true, parse: value => value as boolean });
	const snapshot = { revision: 1, document: { version: 1 as const, source: '{ "status.flag": false }' } };
	using files = new class extends TestConfigurationFiles {
		override async writeFile(..._args: Parameters<TestConfigurationFiles['writeFile']>): ReturnType<TestConfigurationFiles['writeFile']> { throw new Error('Configuration write rejected'); }
	}(snapshot.document.source);
	using configuration = new WorkbenchConfigurationService({ registry, files, source: snapshot.document.source });
	using model = new SettingModel(configurationSettingBinding(configuration, registry.getConfiguration('status.flag') as IRegisteredConfiguration<boolean>));
	const states: { value: boolean; isDefault: boolean; isPending: boolean; }[] = [];
	using listener = model.onDidChange(state => states.push({ value: state.value, isDefault: state.isDefault, isPending: state.isPending }));
	await assert.rejects(model.reset(), /Configuration write rejected/u);
	assert.deepEqual(states, [{ value: true, isDefault: false, isPending: true }, { value: false, isDefault: false, isPending: false }]);
	assert.equal((await configuration.read()).source, snapshot.document.source);
	assert.equal(configuration.inspect('status.flag').userLocalValue, false);
});

test('Domain setting bindings retain their own default and reset behavior', async () => {
	let current = 3;
	let resets = 0;
	using model = new SettingModel({
		id: 'domain.setting', defaultValue: 3, getValue: () => current,
		updateValue: async value => { current = value; },
		resetValue: async () => { current = 3; resets++; },
	});
	assert.equal(model.isDefault(), true);
	await model.update(4);
	assert.equal(model.isDefault(), false);
	await model.reset();
	assert.deepEqual([model.isDefault(), current, resets], [true, 3, 1]);
});

test('profile settings use the ordinary file service and its opaque revision contract', async () => {
	const registry = testRegistry();
	using configuration = new WorkbenchConfigurationService({ registry, onError() { } });
	const files = configuration.fileService;
	const initial = await files.readFile(UserSettingsResource);
	const source = '{\n\t// Preserve this explanation.\n\t"editor.enabled": false,\n\t"extension.unregistered": 1,\n}\n';
	const saved = await files.writeFile({ resource: UserSettingsResource, content: source, expectedRevision: initial.revision });
	await configuration.reloadConfiguration();
	assert.notEqual(saved.revision, initial.revision);
	assert.equal((await files.readFile(UserSettingsResource)).content, source);
	assert.equal(configuration.getValue('editor.enabled'), false);
	assert.equal((await files.stat(UserSettingsResource)).readonly, false);
	await assert.rejects(files.writeFile({ resource: UserSettingsResource, content: '{}', expectedRevision: initial.revision }), FileRevisionConflictError);
	await files.writeFile({ resource: UserSettingsResource, content: '{ "editor.enabled": "yes" }', expectedRevision: saved.revision });
	await assert.rejects(configuration.reloadConfiguration(), /editor\.enabled/);
	assert.equal(configuration.getValue('editor.enabled'), false);
});

test('generic JSON schema completion is resource-scoped and omits configured keys', async () => {
	const registry = testRegistry();
	using schemaStore = new DisposableStore();
	const schemas = jsonRegistry;
	schemas.registerSchema(ConfigurationSchemaId, createConfigurationSchema(registry), schemaStore);
	using association = schemas.registerSchemaAssociation(ConfigurationSchemaId, UserSettingsResource.toString());
	const provider = createJsonCompletionProvider(schemas);
	using model = new TextModel(`{
	"editor.enabled": true,
	"editor.
}`);
	const position = new Position((2) + 1, (model.getLineLength((2) + 1)) + 1);
	const result = await provider.provideCompletions({
		requestId: 1,
		languageId: 'jsonc',
		resource: UserSettingsResource,
		position,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);

	assert.deepEqual(result?.items.map(item => item.label), ['editor.fontFamily']);
	assert.equal(result?.items[0]?.insertText, '"editor.fontFamily": ""');
	using triggeredModel = new TextModel(`{
	"
}`);
	const triggered = await provider.provideCompletions({
		requestId: 2,
		languageId: 'jsonc',
		resource: UserSettingsResource,
		position: new Position((1) + 1, (triggeredModel.getLineLength((1) + 1)) + 1),
		context: { kind: LanguageCompletionTriggerKind.TriggerCharacter, triggerCharacter: '"' },
		snapshot: triggeredModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(triggered?.items.map(item => item.label), ['editor.enabled', 'editor.fontFamily']);
	const unassociated = await provider.provideCompletions({
		requestId: 3,
		languageId: 'jsonc',
		resource: UserSettingsResource.with({ path: '/user/other.json' }),
		position,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(unassociated?.items.map(item => item.label), ['$schema']);

	using valueModel = new TextModel('{ "editor.fontFamily": "editor. }');
	const valuePosition = valueModel.getLineContent((0) + 1).lastIndexOf('editor.') + 'editor.'.length;
	const valueResult = await provider.provideCompletions({
		requestId: 4,
		languageId: 'jsonc',
		resource: UserSettingsResource,
		position: new Position((0) + 1, (valuePosition) + 1),
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: valueModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(valueResult?.items.map(item => item.insertText), ['""']);
	using nestedModel = new TextModel(`{
	"nested": {
		"editor.
	}
}`);
	assert.equal(await provider.provideCompletions({
		requestId: 5,
		languageId: 'jsonc',
		resource: UserSettingsResource,
		position: new Position((2) + 1, (nestedModel.getLineLength((2) + 1)) + 1),
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: nestedModel.createVersionedSnapshot(),
	}, new AbortController().signal), undefined);
});

test('PreferencesService opens User Settings JSON as a pinned JSON editor input', async () => {
	let opened: { readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target: EditorOpenTarget | undefined; } | undefined;
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor(input, options, target): Promise<void> {
			opened = { input, options, target };
			return Promise.resolve();
		},
		focusActiveEditor() { },
	};
	using models = uriIdentityServices.createInstance(BrowserTextModelService, { onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '{}', revision: undefined }), save: async () => ({ revision: undefined }) } satisfies ITextResourceStore, {});
	using configuration = new WorkbenchConfigurationService();
	using preferences = new PreferencesService(editorService, models, keybindingProfile.files, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, emptyEditorGroupsService);

	await preferences.openUserSettings({ jsonEditor: true });
	assert.equal((await keybindingProfile.files.readFile(UserSettingsResource)).content, '{}\n');
	const existing = '// retain this comment\n{ "editor.fontSize": 19 }';
	await keybindingProfile.files.writeFile({ resource: UserSettingsResource, content: existing });
	await preferences.openUserSettings({ jsonEditor: true });
	assert.equal((await keybindingProfile.files.readFile(UserSettingsResource)).content, existing);
	assert.equal(opened?.input.resource.toString(), UserSettingsResource.toString());
	assert.equal(opened?.input.languageId, 'jsonc');
	assert.equal(opened?.input.label, 'User Settings (JSON)');
	assert.equal(opened?.options?.pinned, true);
	assert.equal(opened?.target, undefined);
});

test('PreferencesService honors the persisted default and explicit UI or JSON requests without changing the preference', async () => {
	using configuration = new WorkbenchConfigurationService();
	using textFiles = createTestTextFileService(configuration.fileService);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	const opens: { input: IResourceEditorInput; options?: EditorOpenOptions; target?: EditorOpenTarget; }[] = [];
	using preferences = new PreferencesService({
		...emptyEditorServiceState,
		openEditor: async (input, options, target) => { opens.push({ input, options, target }); },
		focusActiveEditor() { },
	}, models, configuration.fileService, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, emptyEditorGroupsService);
	assert.equal(configuration.getValue(WorkbenchConfiguration.settingsEditor), 'ui');
	await preferences.openSettings();
	assert.ok(opens.at(-1)?.input instanceof SettingsEditorInput);
	assert.equal(opens.at(-1)?.target, 'modalGroup');
	await configuration.write('{\n // preserve this comment\n "workbench.settings.editor": "json", "editor.fontSize": 19\n}\n');
	const source = (await configuration.read()).source;
	await preferences.openSettings({ query: '@id:editor.fontFamily' });
	assert.equal(opens.at(-1)?.options?.selection, undefined);
	using firstReference = await models.acquire(opens.at(-1)!.input, new AbortController().signal);
	assert.equal(firstReference.model.getValue(), source, 'switching does not insert a setting that was only searched');
	assert.equal(firstReference.isDirty, false);
	await preferences.openSettings({ query: '@id:editor.fontSize' });
	assert.equal(opens.at(-1)?.input.resource.toString(), UserSettingsResource.toString());
	using reference = await models.acquire(opens.at(-1)!.input, new AbortController().signal);
	assert.equal(reference.model.getValueInRange(opens.at(-1)!.options!.selection!), '19');
	const saved = (await configuration.read()).source;
	await preferences.openUserSettings({ jsonEditor: false });
	assert.ok(opens.at(-1)?.input instanceof SettingsEditorInput);
	assert.equal(configuration.getValue(WorkbenchConfiguration.settingsEditor), 'json');
	await preferences.openUserSettings();
	assert.equal(opens.at(-1)?.input.resource.toString(), UserSettingsResource.toString());
	assert.equal((await configuration.read()).source, saved);
	const model = reference.model;
	model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: '{ invalid draft' }], null);
	await preferences.openSettings({ jsonEditor: true, query: '@id:editor.fontSize' });
	assert.equal(opens.at(-1)?.input.resource.toString(), UserSettingsResource.toString());
	assert.equal(opens.at(-1)?.options?.selection, undefined);
	assert.equal(model.getValue(), '{ invalid draft', 'the JSON repair entry retains an invalid unsaved draft');
	model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: saved }], null);
	await configuration.updateValue(WorkbenchConfiguration.settingsEditor, 'ui');
	await preferences.openSettings({ jsonEditor: true });
	assert.equal(opens.at(-1)?.input.resource.toString(), UserSettingsResource.toString());
	assert.equal(configuration.getValue(WorkbenchConfiguration.settingsEditor), 'ui');
	await assert.rejects(configuration.updateValue(WorkbenchConfiguration.settingsEditor, 'unsupported'), /ui or json/u);
	const count = opens.length;
	await assert.rejects(preferences.openSettings({ jsonEditor: 'json' } as unknown as IOpenSettingsOptions));
	await assert.rejects(preferences.openSettings({ jsonEditor: true, revealSetting: { key: '' } }));
	assert.equal(opens.length, count);
});

test('PreferencesService passes graphical queries and sections while rejecting unsupported options before opening', async () => {
	const opened: IResourceEditorInput[] = [];
	const requests: IOpenSettingsOptions[] = [];
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor(input, options, target): Promise<void> {
			assert.equal(target, 'modalGroup');
			assert.equal(options?.pinned, true);
			requests.push(options as IOpenSettingsOptions);
			assert.ok(input instanceof SettingsEditorInput);
			opened.push(input);
			return Promise.resolve();
		},
		focusActiveEditor() { },
	};
	using models = uriIdentityServices.createInstance(BrowserTextModelService, { onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '{}', revision: undefined }), save: async () => ({ revision: undefined }) } satisfies ITextResourceStore, {});
	using configuration = new WorkbenchConfigurationService();
	using preferences = new PreferencesService(editorService, models, keybindingProfile.files, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, emptyEditorGroupsService);
	for (const query of ['editor.fontFamily', 'font & 中文 + @id:editor.font*', '']) {
		await preferences.openSettings({ query, section: 'models', target: ConfigurationTarget.USER_LOCAL });
		assert.deepEqual(requests.at(-1), { query, section: 'models', target: ConfigurationTarget.USER_LOCAL, pinned: true, preserveFocus: false, ignoreError: true });
		assert.deepEqual(Object.fromEntries(new URLSearchParams(createSettingsEditorInput('models', { query }).resource.query)), { query, target: 'models' });
	}
	await preferences.openSettings({ target: ConfigurationTarget.USER });
	assert.equal(opened.at(-1)!.resource.query, '');
	await configuration.updateValue(WorkbenchConfiguration.settingsEditor, 'json');
	await preferences.openSettings({ section: 'models', query: '', sectionQuery: '@provider:openai @capability:vision' });
	assert.equal(requests.at(-1)?.sectionQuery, '@provider:openai @capability:vision');
	for (const options of [null, [], true, { query: 1 }, { focusSearch: 'yes' }, { folderUri: '/not-a-uri' }, { target: ConfigurationTarget.WORKSPACE_FOLDER }, { groupId: '1' }, { groupId: -1 }, { groupId: 1.5 }, { openToSide: 'yes' }, { section: '' }, { section: 1 }, { sectionQuery: 'raw' }, { section: 'models', sectionQuery: 3 }, { section: 'models', sectionQuery: 'raw', jsonEditor: true }, { revealSetting: { key: 3 } }, { jsonEditor: 'json' }, { target: ConfigurationTarget.WORKSPACE }, { target: ConfigurationTarget.USER_REMOTE }]) {
		await assert.rejects(preferences.openSettings(options as IOpenSettingsOptions));
	}
	assert.equal(opened.length, 5, 'rejected requests never reach EditorService');
	assert.equal(requests.length, 5);
	assert.ok(opened.every(input => input === opened[0]), 'opening options retain the same Settings resource identity');
	const input = opened[0]!;
	assert.ok(input instanceof SettingsEditorInput);
	preferences.dispose();
	assert.equal(input.isDisposed, true);
	assert.equal(requests.length, 5, 'disposal does not broadcast further pane options');
});

test('Preferences routes UI and JSON to numeric groups, falls back for closed groups and prefers side opening', async () => {
	using configuration = new WorkbenchConfigurationService();
	using textFiles = createTestTextFileService(configuration.fileService);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	const opens: { input: IResourceEditorInput; target?: EditorOpenTarget; }[] = [];
	const chosen = { ...emptyEditorGroupsService.activeGroup, id: 7 };
	const groups: IEditorGroupsService = { ...emptyEditorGroupsService, getGroup: id => id === chosen.id ? chosen : undefined };
	using preferences = new PreferencesService({
		...emptyEditorServiceState,
		openEditor: async (input, _options, target) => { opens.push({ input, target }); },
		focusActiveEditor() { },
	}, models, configuration.fileService, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, groups);
	await preferences.openSettings({ groupId: 7 });
	assert.deepEqual(opens.at(-1)?.target, { groupId: 7 });
	await preferences.openSettings({ groupId: 999 });
	assert.deepEqual(opens.at(-1)?.target, { groupId: groups.activeGroup.id });
	await preferences.openSettings({ groupId: 0 });
	assert.deepEqual(opens.at(-1)?.target, { groupId: groups.activeGroup.id });
	await preferences.openSettings({ groupId: 7, openToSide: true });
	assert.equal(opens.at(-1)?.target, 'sideGroup');
	await preferences.openSettings({ jsonEditor: true, groupId: 7 });
	assert.deepEqual(opens.at(-1)?.target, { groupId: 7 });
	assert.equal(opens.at(-1)?.input.resource.toString(), UserSettingsResource.toString());
	await preferences.openSettings({ jsonEditor: true, groupId: 7, openToSide: true, revealSetting: { key: 'editor.fontSize', edit: true } });
	assert.equal(opens.at(-1)?.target, 'sideGroup');
});

test('settings schema changes notify cached language services when contributed settings arrive and retire', async () => {
	using configuration = new WorkbenchConfigurationService();
	using textFiles = createTestTextFileService(configuration.fileService);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	using contribution = new PreferencesContribution(models, new UserDataProfileService(), new NullLoggerService());
	const changes: string[] = [];
	using listener = jsonRegistry.onDidChangeSchema(uri => changes.push(uri));
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	const node = { properties: { 'test.json.dynamicExtension': { type: 'boolean' as const, default: true } } };
	try {
		registry.updateConfigurations({ add: [node], remove: [] });
		assert.deepEqual(changes, [ConfigurationSchemaId]);
		assert.equal(jsonRegistry.getSchemaContributions().schemas[ConfigurationSchemaId]?.properties?.['test.json.dynamicExtension']?.default, true);
		registry.updateConfigurations({ add: [], remove: [node] });
		assert.deepEqual(changes, [ConfigurationSchemaId, ConfigurationSchemaId]);
		assert.equal(jsonRegistry.getSchemaContributions().schemas[ConfigurationSchemaId]?.properties?.['test.json.dynamicExtension'], undefined);
		contribution.dispose();
		registry.updateConfigurations({ add: [node], remove: [] });
		assert.equal(changes.length, 3, 'disposing the schema emits its final removal, then retires the configuration listener');
	} finally {
		registry.updateConfigurations({ add: [], remove: [node] });
	}
});

test('settings JSON saves validate registered values through the text model participant', async () => {
	using configuration = new WorkbenchConfigurationService();
	using textFiles = createTestTextFileService(configuration.fileService);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	using contribution = new PreferencesContribution(models, new UserDataProfileService(), new NullLoggerService());
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	reference.model.setValue('{ "editor.fontSize": "invalid" }');
	await assert.rejects(reference.save(new AbortController().signal), /editor.fontSize/);
	assert.equal(reference.isDirty, true);
	assert.equal((await configuration.read()).source, '{}\n');
	reference.model.setValue('{ "editor.fontSize": 19, "extension.unknown": true }');
	await reference.save(new AbortController().signal);
	assert.equal(reference.isDirty, false);
	assert.equal(JSON.parse((await configuration.read()).source)['editor.fontSize'], 19);
});

test('the text-model save path updates configuration and accepts later external changes', async () => {
	const registry = testRegistry();
	const enabled = registry.getConfiguration('editor.enabled')!.key;
	using configuration = new WorkbenchConfigurationService({ registry });
	const provider = configuration.fileService;
	using textFiles = createTestTextFileService(provider);
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	reference.model.applyOperations([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), reference.model.positionAt(reference.model.length)),
		text: '{\n\t// Keep me.\n\t"editor.enabled": false,\n}\n',
	}]);

	assert.equal(reference.isDirty, true);
	const savedConfiguration = new Promise<void>(resolve => Event.once(configuration.onDidChangeConfiguration)(() => resolve()));
	await reference.save(new AbortController().signal);
	await savedConfiguration;
	assert.equal(configuration.getValue(enabled), false);
	assert.equal(reference.isDirty, false);
	assert.equal(reference.hasExternalChange, false);

	const reloadedModel = new Promise<void>(resolve => Event.once(reference.model.onDidChangeContent)(() => resolve()));
	await configuration.updateValue(enabled, true);
	await reloadedModel;
	assert.equal(configuration.getValue(enabled), true);
	assert.match(reference.model.getText(), /Keep me/u);
	assert.doesNotMatch(reference.model.getText(), /"editor\.enabled"/u);
	assert.equal(reference.hasExternalChange, false);
});

test('PreferencesService uses the shared dirty model, inserts an undoable default and reveals the top-level value', async () => {
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	using configuration = new WorkbenchConfigurationService({ registry });
	const provider = configuration.fileService;
	using textFiles = createTestTextFileService(provider);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	const before = '{\n\t// editor.fontSize is mentioned here, not configured.\n\t"extension.data": { "editor.fontSize": 99 },\n}\n';
	reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: before }]);
	let selection: Range | undefined;
	using services = new InstantiationService();
	services.registerInstance(EditorServiceId, {
		...emptyEditorServiceState,
		openEditor: async (_input, options) => { selection = options?.selection; },
		focusActiveEditor() { },
	});
	assert.throws(() => services.createInstance(PreferencesService), /Unknown service: fileTextModelService/u);
	services.registerInstance(IFileTextModelService, models);
	services.registerInstance(IFileService, keybindingProfile.files);
	services.registerInstance(IUserDataProfileService, keybindingProfile.profiles);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IWorkspaceContextService, configuration);
	services.registerInstance(IEditorGroupsService, emptyEditorGroupsService);
	using preferences = services.createInstance(PreferencesService);

	await preferences.openUserSettings({ jsonEditor: true, target: ConfigurationTarget.USER_LOCAL, revealSetting: { key: 'editor.fontSize', edit: true } });
	assert.equal(reference.isDirty, true);
	assert.equal((await configuration.read()).source, '{}\n');
	assert.match(reference.model.getText(), /extension.data.*99/u);
	assert.match(reference.model.getText(), /mentioned here/u);
	assert.ok(selection);
	assert.equal(reference.model.getValueInRange(selection), String(registry.getConfiguration('editor.fontSize')!.defaultValue));
	await reference.model.undo();
	assert.equal(reference.model.getText(), before);
	await reference.model.redo();
	await reference.save(new AbortController().signal);
	assert.match((await configuration.read()).source, /"editor.fontSize"/u);

	await preferences.openUserSettings({ jsonEditor: true, revealSetting: { key: 'editor.fontSize' } });
	assert.equal(reference.model.getValueInRange(selection!), '"editor.fontSize"');
	await assert.rejects(preferences.openUserSettings({ target: ConfigurationTarget.WORKSPACE }), /Open a workspace/u);
});

test('revealing existing settings preserves edits and real external conflicts reject saves', async () => {
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	using configuration = new WorkbenchConfigurationService({ registry });
	const provider = configuration.fileService;
	using textFiles = createTestTextFileService(provider);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	const source = '{ "editor.fontSize": 18, "extension.pending": true }';
	reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: source }]);
	let selection: Range | undefined;
	using preferences = new PreferencesService({
		...emptyEditorServiceState,
		openEditor: async (_input, options) => { selection = options?.selection; },
		focusActiveEditor() { },
	}, models, keybindingProfile.files, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, emptyEditorGroupsService);
	await preferences.openUserSettings({ jsonEditor: true, revealSetting: { key: 'editor.fontSize', edit: true } });
	assert.equal(reference.model.getText(), source);
	assert.equal(reference.model.getValueInRange(selection!), '18');

	await configuration.updateValue('editor.fontSize', 20);
	await nextTurn();
	await assert.rejects(reference.save(new AbortController().signal), TextModelConflictError);
	assert.equal(reference.model.getText(), source);
	assert.equal(configuration.getValue('editor.fontSize'), 20);

	reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: '{ broken' }]);
	await assert.rejects(preferences.openUserSettings({ jsonEditor: true, revealSetting: { key: 'editor.fontSize', edit: true } }), /JSON errors/u);
	assert.equal(reference.model.getText(), '{ broken');
	await assert.rejects(reference.save(new AbortController().signal), TextModelConflictError);
});

test('SmartSnippetInserter preserves object-array punctuation around the cursor', () => {
	using empty = new TextModel('[]');
	assert.deepEqual(SmartSnippetInserter.insertSnippet(empty, new Position((0) + 1, (0) + 1)), {
		position: new Position((0) + 1, (1) + 1),
		prepend: '',
		append: '',
	});

	using populated = new TextModel(`[
{}
]`);
	assert.deepEqual(SmartSnippetInserter.insertSnippet(populated, new Position((1) + 1, (1) + 1)), {
		position: new Position((1) + 1, (0) + 1),
		prepend: '',
		append: ',',
	});
	assert.deepEqual(SmartSnippetInserter.insertSnippet(populated, new Position((1) + 1, (2) + 1)), {
		position: new Position((1) + 1, (2) + 1),
		prepend: ',',
		append: '',
	});

	using invalid = new TextModel('// no array');
	assert.deepEqual(SmartSnippetInserter.insertSnippet(invalid, new Position((0) + 1, (0) + 1)), {
		position: new Position((0) + 1, (11) + 1),
		prepend: '\n[',
		append: ']',
	});
});

function testRegistry(): ConfigurationRegistry {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'editor.enabled',
		defaultValue: true,
		parse(value): boolean {
			if (typeof value !== 'boolean') throw new TypeError('editor.enabled must be a boolean');
			return value;
		},
		setting: {
			valueType: 'boolean',
			title: 'Enabled',
			description: 'Enable the editor.',
		},
	});
	registry.registerConfiguration({
		key: 'editor.fontFamily',
		defaultValue: '',
		parse(value): string {
			if (typeof value !== 'string') throw new TypeError('editor.fontFamily must be text');
			return value;
		},
		setting: {
			valueType: 'text',
			title: 'Font family',
			description: 'Choose the editor font.',
			placeholder: 'Default monospace',
		},
	});
	return registry;
}

async function nextTurn(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}


test('Settings bindings keep target and language writes isolated through reset and resource changes', async () => {
	using files = new TestConfigurationFiles('{ "scope.size": 17, "scope.null": null, "[plaintext]": { "scope.size": 18 } }');
	using provider = new InMemoryFileSystemProvider();
	using registration = files.registerProvider('settings-test', provider);
	const workspaceFile = URI.parse('settings-test:/work/project.ash-workspace');
	const root = URI.parse('settings-test:/work/root');
	const folderFile = URI.joinPath(root, '.vscode', 'settings.json');
	await files.createDirectory(URI.joinPath(root, '.vscode'));
	await files.writeFile({ resource: workspaceFile, content: '// retain workspace\n{ "folders": [], "settings": { "scope.size": 21, "[plaintext]": { "scope.size": 22 } }, "unrelated": true }' });
	await files.writeFile({ resource: folderFile, content: '{ "scope.size": 25, "[plaintext]": { "scope.size": 26 } }' });
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'scope.size', defaultValue: 14, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, parse: Number });
	registry.registerConfiguration<string | null>({ key: 'scope.null', defaultValue: 'fallback', parse: value => value === null ? null : String(value) });
	using configuration = new WorkbenchConfigurationService({ files, registry, workspace: { id: 'settings', configuration: workspaceFile, folders: [{ id: 'root', index: 0, name: 'Root', uri: root }] } });
	await configuration.initialize(files);
	assert.equal(configurationSettingBinding(configuration, registry.getConfiguration('scope.null')!).getValue(), null);
	const setting = registry.getConfiguration('scope.size') as IRegisteredConfiguration<number>;
	const address = { resource: root, overrideIdentifier: 'plaintext' };
	const user = configurationSettingBinding(configuration, setting, address, ConfigurationTarget.USER_LOCAL);
	const workspace = configurationSettingBinding(configuration, setting, address, ConfigurationTarget.WORKSPACE);
	const folder = configurationSettingBinding(configuration, setting, address, ConfigurationTarget.WORKSPACE_FOLDER);
	assert.deepEqual([user.getValue(), workspace.getValue(), folder.getValue()], [18, 22, 26]);
	address.overrideIdentifier = 'other-language';
	await folder.updateValue(29);
	assert.deepEqual([user.getValue(), workspace.getValue(), folder.getValue()], [18, 22, 29], 'controls retain their original address');
	assert.equal(configuration.inspect('scope.size', { resource: root, overrideIdentifier: 'other-language' }).workspaceFolder?.override, undefined);
	await folder.resetValue();
	assert.deepEqual([folder.getValue(), folder.isDefault!()], [14, true]);
	assert.deepEqual(JSON.parse((await files.readFile(folderFile)).content), { 'scope.size': 25 });
	assert.equal(configurationSettingBinding(configuration, setting, { resource: root }, ConfigurationTarget.WORKSPACE_FOLDER).getValue(), 25);
	await workspace.updateValue(30);
	assert.match((await files.readFile(workspaceFile)).content, /retain workspace/u);
	assert.match((await files.readFile(workspaceFile)).content, /"unrelated": true/u);
	assert.equal(user.getValue(), 18);
	await workspace.resetValue();
	assert.deepEqual([workspace.isDefault!(), configuration.inspect('scope.size').workspaceValue], [true, 21]);
	const pending = workspace.updateValue(33);
	configuration.updateWorkspace({ id: 'replacement', folders: [] });
	await assert.rejects(pending, /Cancel/i);
	assert.doesNotMatch((await files.readFile(workspaceFile)).content, /33/);

});

test('Preferences resolves folder and nested workspace JSON without replacing dirty models or unrelated workspace data', async () => {
	using files = new TestConfigurationFiles();
	using provider = new InMemoryFileSystemProvider();
	using registration = files.registerProvider('settings-json-test', provider);
	const root = URI.parse('settings-json-test:/work/root');
	const workspaceFile = URI.parse('settings-json-test:/work/project.ash-workspace');
	await files.createDirectory(root);
	await files.writeFile({ resource: workspaceFile, content: '// keep workspace\n{ "folders": [], "settings": { /* keep setting */ "editor.fontSize": 19 }, "unrelated": true }' });
	using configuration = new WorkbenchConfigurationService({ files, workspace: { id: 'settings', configuration: workspaceFile, folders: [{ id: 'root', index: 0, name: 'Root', uri: root }] } });
	using textFiles = createTestTextFileService(files, configuration);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
	const opened: { input: IResourceEditorInput; options?: EditorOpenOptions; }[] = [];
	using preferences = new PreferencesService({ ...emptyEditorServiceState, openEditor: async (input, options) => { opened.push({ input, options }); }, focusActiveEditor() { } }, models, files, keybindingProfile.profiles, keybindingProfile.services, configuration, configuration, emptyEditorGroupsService);
	await preferences.openSettings({ target: ConfigurationTarget.WORKSPACE, jsonEditor: true, revealSetting: { key: 'editor.fontSize', edit: true } });
	assert.equal(opened.at(-1)!.input.resource.toString(), workspaceFile.toString());
	using reference = await models.acquire(opened.at(-1)!.input, new AbortController().signal);
	assert.equal(reference.model.getValueInRange(opened.at(-1)!.options!.selection!), '19');
	const before = reference.model.getValue();
	await preferences.openSettings({ target: ConfigurationTarget.WORKSPACE, jsonEditor: true, revealSetting: { key: 'editor.fontFamily', edit: true } });
	assert.equal(reference.isDirty, true);
	assert.match(reference.model.getValue(), /keep setting/u);
	assert.match(reference.model.getValue(), /"unrelated": true/u);
	assert.equal((await files.readFile(workspaceFile)).content, before);
	reference.model.setValue('{ "settings": "repair me", "unrelated": true }');
	await preferences.openSettings({ target: ConfigurationTarget.WORKSPACE, jsonEditor: true, query: '@id:editor.fontSize' });
	assert.equal(opened.at(-1)!.options?.selection, undefined, 'a search hint still opens a malformed settings object for repair');
	await assert.rejects(preferences.openSettings({ target: ConfigurationTarget.WORKSPACE, jsonEditor: true, revealSetting: { key: 'editor.fontSize', edit: true } }), /JSON errors/u);
	assert.equal(reference.model.getValue(), '{ "settings": "repair me", "unrelated": true }');

	await preferences.openSettings({ target: ConfigurationTarget.WORKSPACE_FOLDER, folderUri: root, jsonEditor: true });
	assert.equal(opened.at(-1)!.input.resource.toString(), URI.joinPath(root, '.vscode', 'settings.json').toString());
	const count = opened.length;
	await assert.rejects(preferences.openSettings({ target: ConfigurationTarget.WORKSPACE_FOLDER, folderUri: URI.parse('settings-json-test:/elsewhere'), query: 'should not open' }));
	assert.equal(opened.length, count);
});

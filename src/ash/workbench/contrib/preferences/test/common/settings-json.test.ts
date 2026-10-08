import { createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import '../../../codeEditor/common/editorConfiguration.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
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
import { WorkbenchConfigurationService } from '../../../../../workbench/services/configuration/browser/configurationService.js';
import { BrowserTextResourceStore } from '../../../../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import type { EditorOpenOptions, EditorOpenTarget, IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { PreferencesService } from '../../../../../workbench/services/preferences/browser/preferencesService.js';
import { configurationSettingBinding, SettingModel } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { UserSettingsResource } from '../../../../../workbench/services/preferences/common/settingsEditorInput.js';
import { SettingsFileSystemProvider } from '../../../../../workbench/contrib/preferences/common/settingsFilesystemProvider.js';
import { createJsonCompletionProvider } from '../../../../../workbench/services/language/common/jsonLanguageFeatures.js';
import { SmartSnippetInserter } from '../../../../../workbench/contrib/preferences/common/smartSnippetInserter.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

const keybindingProfile = new KeybindingTestServices();
suiteTeardown(() => keybindingProfile.dispose());

test('Reset removes explicitly saved scalar and structured defaults while preserving unrelated JSONC', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'editor.fontSize', defaultValue: 14, parse: value => Number(value) });
	registry.registerConfiguration({ key: 'workbench.colors', defaultValue: {}, parse: value => value as Record<string, unknown> });
	using configuration = new WorkbenchConfigurationService({ registry });
	await configuration.write('{\n\t// Keep unrelated settings.\n\t"editor.fontSize": 14,\n\t"workbench.colors": {},\n\t"extension.data": 99,\n}\n', 0);

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

	await configuration.write('{ "status.flag": true }', 0);
	assert.deepEqual(states, [{ value: true, isDefault: false, isPending: false }]);
	model.refresh();
	await configuration.write('{ "status.flag": true }', 1);
	assert.equal(states.length, 1, 'unchanged snapshots do not repeat the configured notification');
	await configuration.write('{ "[typescript]": { "status.flag": false } }', 2);
	assert.deepEqual(states, [
		{ value: true, isDefault: false, isPending: false },
		{ value: true, isDefault: true, isPending: false },
	]);
	await configuration.write('{ "[typescript]": { "status.flag": true } }', 3);
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
	using configuration = new WorkbenchConfigurationService({
		registry, initialSnapshot: snapshot,
		api: { read: async () => snapshot, update: async () => { throw new Error('Configuration write rejected'); }, onDidChange: Event.None },
	});
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

test('SettingsFileSystemProvider projects only the editable JSONC settings resource', async () => {
	const registry = testRegistry();
	using configuration = new WorkbenchConfigurationService({ registry });
	using provider = new SettingsFileSystemProvider(configuration);
	const changes: string[] = [];
	using listener = provider.onDidChangeFiles(event => changes.push(event.resources?.[0]?.toString() ?? '*'));

	assert.deepEqual(await provider.readFile(UserSettingsResource), {
		resource: UserSettingsResource,
		bytes: new TextEncoder().encode('{}\n'),
		revision: 'settings:0',
	});
	const saved = await provider.writeFile(UserSettingsResource, new TextEncoder().encode('{\n\t// Preserve this explanation.\n\t"editor.enabled": false,\n\t"extension.unregistered": 1,\n}\n'), { create: true, overwrite: true, expectedRevision: 'settings:0' });
	assert.equal(saved.revision, 'settings:1');
	assert.equal(saved.stat.sizeBytes, (await provider.readFile(UserSettingsResource)).bytes.byteLength);
	assert.deepEqual(changes, [UserSettingsResource.toString()]);
	assert.match(new TextDecoder().decode((await provider.readFile(UserSettingsResource)).bytes), /Preserve this explanation/u);
	assert.equal((await provider.stat(UserSettingsResource)).readonly, false);

	await assert.rejects(() => provider.writeFile(UserSettingsResource, new TextEncoder().encode('{}'), { create: true, overwrite: true, expectedRevision: 'settings:0' }), FileRevisionConflictError);
	await assert.rejects(() => provider.writeFile(UserSettingsResource, new TextEncoder().encode('{ "editor.enabled": "yes" }'), { create: true, overwrite: true, expectedRevision: 'settings:1' }), /editor\.enabled/);
	await assert.rejects(() => provider.readFile(URI.parse('ash-settings:/missing.json')), /does not exist/);
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
	assert.equal(await provider.provideCompletions({
		requestId: 3,
		languageId: 'jsonc',
		resource: URI.parse('ash-settings:/other.json'),
		position,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal), undefined);

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
	using models = new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '{}', revision: undefined }), save: async () => ({ revision: undefined }) });
	using preferences = new PreferencesService(editorService, models, keybindingProfile.files, keybindingProfile.profiles, keybindingProfile.services);

	await preferences.openUserSettings();
	assert.equal(opened?.input.resource.toString(), UserSettingsResource.toString());
	assert.equal(opened?.input.languageId, 'jsonc');
	assert.equal(opened?.input.label, 'User Settings (JSON)');
	assert.equal(opened?.options?.pinned, true);
	assert.equal(opened?.target, undefined);
});

test('the text-model save path updates configuration and accepts later external changes', async () => {
	const registry = testRegistry();
	const enabled = registry.getConfiguration('editor.enabled')!.key;
	using configuration = new WorkbenchConfigurationService({ registry });
	using provider = new SettingsFileSystemProvider(configuration);
	using textFiles = createTestTextFileService(provider);
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	reference.model.applyOperations([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), reference.model.positionAt(reference.model.length)),
		text: '{\n\t// Keep me.\n\t"editor.enabled": false,\n}\n',
	}]);

	assert.equal(reference.isDirty, true);
	await reference.save(new AbortController().signal);
	assert.equal(configuration.getValue(enabled), false);
	assert.equal(reference.isDirty, false);
	assert.equal(reference.hasExternalChange, false);

	await configuration.updateValue(enabled, true);
	await nextTurn();
	assert.equal(configuration.getValue(enabled), true);
	assert.match(reference.model.getText(), /Keep me/u);
	assert.doesNotMatch(reference.model.getText(), /"editor\.enabled"/u);
	assert.equal(reference.hasExternalChange, false);
});

test('PreferencesService uses the shared dirty model, inserts an undoable default and reveals the top-level value', async () => {
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	using configuration = new WorkbenchConfigurationService({ registry });
	using provider = new SettingsFileSystemProvider(configuration);
	using textFiles = createTestTextFileService(provider);
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
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
	using preferences = services.createInstance(PreferencesService);

	await preferences.openUserSettings({ target: ConfigurationTarget.USER_LOCAL, revealSetting: { key: 'editor.fontSize', edit: true } });
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

	await preferences.openUserSettings({ revealSetting: { key: 'editor.fontSize' } });
	assert.equal(reference.model.getValueInRange(selection!), '"editor.fontSize"');
	await assert.rejects(preferences.openUserSettings({ target: ConfigurationTarget.WORKSPACE }), /configuration target/u);
});

test('revealing existing settings preserves edits and real external conflicts reject saves', async () => {
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	using configuration = new WorkbenchConfigurationService({ registry });
	using provider = new SettingsFileSystemProvider(configuration);
	using textFiles = createTestTextFileService(provider);
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	using reference = await models.acquire({ resource: UserSettingsResource }, new AbortController().signal);
	const source = '{ "editor.fontSize": 18, "extension.pending": true }';
	reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: source }]);
	let selection: Range | undefined;
	using preferences = new PreferencesService({
		...emptyEditorServiceState,
		openEditor: async (_input, options) => { selection = options?.selection; },
		focusActiveEditor() { },
	}, models, keybindingProfile.files, keybindingProfile.profiles, keybindingProfile.services);
	await preferences.openUserSettings({ revealSetting: { key: 'editor.fontSize', edit: true } });
	assert.equal(reference.model.getText(), source);
	assert.equal(reference.model.getValueInRange(selection!), '18');

	await configuration.updateValue('editor.fontSize', 20);
	await nextTurn();
	await assert.rejects(reference.save(new AbortController().signal), TextModelConflictError);
	assert.equal(reference.model.getText(), source);
	assert.equal(configuration.getValue('editor.fontSize'), 20);

	reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: '{ broken' }]);
	await assert.rejects(preferences.openUserSettings({ revealSetting: { key: 'editor.fontSize', edit: true } }), /JSON errors/u);
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

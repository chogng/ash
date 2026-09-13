import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageCompletionTriggerKind } from '../../../../../editor/common/languages/completion/languageCompletionProviders.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { URI } from '../../../../../base/common/uri.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationSchemaId, createConfigurationSchema } from '../../../../../platform/configuration/common/configurationSchema.js';
import { FileRevisionConflictError } from '../../../../../platform/files/common/files.js';
import { JsonSchemaRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { WorkbenchConfigurationService } from '../../../../../workbench/services/configuration/browser/configurationService.js';
import { BrowserTextResourceStore } from '../../../../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import type { EditorInput, EditorOpenOptions, EditorOpenTarget, IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { PreferencesService } from '../../../../../workbench/services/preferences/browser/preferencesService.js';
import { TextFileService } from '../../../../../workbench/services/textfile/common/textFileService.js';
import { UserSettingsResource } from '../../../../../workbench/services/preferences/common/preferencesEditorInput.js';
import { SettingsFileSystemProvider } from '../../../../../workbench/contrib/preferences/common/settingsFilesystemProvider.js';
import { createJsonCompletionProvider } from '../../../../../workbench/services/language/common/jsonLanguageFeatures.js';
import { SmartSnippetInserter } from '../../../../../workbench/contrib/preferences/common/smartSnippetInserter.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

test('SettingsFileSystemProvider projects only the editable JSONC settings resource', async () => {
	const registry = testRegistry();
	using configuration = new WorkbenchConfigurationService({ registry });
	using provider = new SettingsFileSystemProvider(configuration);
	const changes: string[] = [];
	using listener = provider.onDidChangeFiles(event => changes.push(event.resources?.[0]?.toString() ?? '*'));

	assert.deepEqual(await provider.readFile(UserSettingsResource), {
		resource: UserSettingsResource,
		content: '{}\n',
		revision: 'settings:0',
	});
	const saved = await provider.writeFile({
		resource: UserSettingsResource,
		expectedRevision: 'settings:0',
		content: '{\n\t// Preserve this explanation.\n\t"editor.enabled": false,\n\t"extension.unregistered": 1,\n}\n',
	});
	assert.equal(saved.revision, 'settings:1');
	assert.equal(saved.stat.sizeBytes, new TextEncoder().encode((await provider.readFile(UserSettingsResource)).content).byteLength);
	assert.deepEqual(changes, [UserSettingsResource.toString()]);
	assert.match((await provider.readFile(UserSettingsResource)).content, /Preserve this explanation/u);
	assert.equal((await provider.stat(UserSettingsResource)).readonly, false);

	await assert.rejects(() => provider.writeFile({
		resource: UserSettingsResource,
		expectedRevision: 'settings:0',
		content: '{}',
	}), FileRevisionConflictError);
	await assert.rejects(() => provider.writeFile({
		resource: UserSettingsResource,
		expectedRevision: 'settings:1',
		content: '{ "editor.enabled": "yes" }',
	}), /editor\.enabled/);
	await assert.rejects(() => provider.readFile(URI.parse('ash-settings:/missing.json')), /does not exist/);
});

test('generic JSON schema completion is resource-scoped and omits configured keys', async () => {
	const registry = testRegistry();
	const schemas = new JsonSchemaRegistry();
	using schema = schemas.registerSchema(ConfigurationSchemaId, createConfigurationSchema(registry));
	using association = schemas.registerAssociation(UserSettingsResource, ConfigurationSchemaId);
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
	let opened: { readonly input: EditorInput; readonly options: EditorOpenOptions | undefined; readonly target: EditorOpenTarget | undefined } | undefined;
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor(input, options, target): Promise<void> {
			opened = { input, options, target };
			return Promise.resolve();
		},
		focusActiveEditor() {},
	};
	using preferences = new PreferencesService(() => editorService);

	await preferences.openUserSettingsJson();
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
	const textFiles = new TextFileService(provider);
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

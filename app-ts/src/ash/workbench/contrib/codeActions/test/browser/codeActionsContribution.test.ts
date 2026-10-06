import { Registry } from '../../../../../platform/registry/common/platform.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { parseJsonDocument } from '../../../../../base/common/json.js';
import { jsonSchemaAtPath, validateJsonSchema, type JsonSchema } from '../../../../../base/common/jsonSchema.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { createConfigurationSchema } from '../../../../../platform/configuration/common/configurationSchema.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { BrowserKeyboardLayoutService } from '../../../../services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../../services/keybinding/browser/keybindingService.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { CodeActionsContribution } from '../../browser/codeActionsContribution.js';
import '../../browser/codeActions.contribution.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

test('Code Action registration updates settings and command argument suggestions through provider lifetimes', () => {
	const dom = new JSDOM('<body></body>');
	using close = toDisposable(() => dom.window.close());
	using profile = new KeybindingTestServices();
	using contexts = new ContextKeyService();
	using layouts = new BrowserKeyboardLayoutService({ navigator: dom.window.navigator });
	using services = new InstantiationService();
	using commands = new CommandService(services);
	using notifications = new NotificationService();
	using features = new LanguageFeaturesService();
	using keybindings = new WorkbenchKeybindingService({
		ownerDocument: dom.window.document, commandService: commands,
		contextKeyService: contexts, keyboardLayoutService: layouts,
	}, notifications, profile.files, profile.profiles);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerInstance(IKeybindingService, keybindings);
	const provider = {
		providedCodeActionKinds: ['quickfix', 'source.organizeImports', 'source.fixAll', 'refactor.extract', 'refactoring', 'source.organizeImports'],
		provideCodeActions: () => { throw new Error('Schema suggestions must not query a document'); },
	};
	using first = features.codeActionProvider.register('typescript', provider);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [CodeActionsContribution.ID]);
	host.advance(WorkbenchPhase.Eventually);
	const settings = createConfigurationSchema();
	const settingKinds = (): string[] => Object.keys(settings.properties!['editor.codeActionsOnSave'].properties!);
	const shortcutKinds = (command: string): readonly unknown[] => {
		const document = parseJsonDocument(JSON.stringify([{ command, args: { kind: '' } }]));
		return jsonSchemaAtPath(jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings'], [0, 'args', 'kind'], document.root)!.anyOf![0].enum!;
	};
	assert.deepEqual(settingKinds(), ['source.organizeImports', 'source.fixAll']);
	assert.deepEqual(Object.keys(settings.properties!['notebook.codeActionsOnSave'].properties!), settingKinds());
	assert.deepEqual(shortcutKinds('editor.action.refactor'), ['refactor.extract']);
	assert.deepEqual(shortcutKinds('editor.action.sourceAction'), ['source.organizeImports', 'source.fixAll']);
	assert.deepEqual(shortcutKinds('editor.action.codeAction'), [...new Set(provider.providedCodeActionKinds)]);
	assert.equal(validateJsonSchema(parseJsonDocument('[{"key":"ctrl+r","command":"editor.action.refactor","args":{"kind":"refactor.future"}}]'), jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']).length, 0);
	assert.equal(validateJsonSchema(parseJsonDocument('[{"key":"ctrl+r","command":"editor.action.refactor","args":{"kind":42}}]'), jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']).length, 1);
	using second = features.codeActionProvider.register('python', {
		providedCodeActionKinds: ['source.fixAll', 'source.python'], provideCodeActions: () => [],
	});
	first.dispose();
	assert.deepEqual(settingKinds(), ['source.fixAll', 'source.python']);
	assert.deepEqual(shortcutKinds('editor.action.refactor'), []);
	second.dispose();
	assert.deepEqual(settingKinds(), []);
	host.dispose();
	assert.deepEqual(jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']!.definitions!.commandsSchemas.allOf, []);
	using afterClose = features.codeActionProvider.register('typescript', provider);
	assert.deepEqual(settingKinds(), [], 'Disposed contributions must release their provider listeners');
});

test('Code Action settings validate save modes, normalize old values and resolve language overrides', async () => {
	using configuration = new InMemoryConfigurationService();
	const key = 'editor.codeActionsOnSave';
	assert.deepEqual(configuration.getValue(key), {});
	await configuration.updateValue(key, { 'source.future': 'always', 'source.fixAll': true, 'source.organizeImports': false });
	assert.deepEqual(configuration.getValue(key), { 'source.future': 'always', 'source.fixAll': 'explicit', 'source.organizeImports': 'never' });
	await configuration.updateValue(key, { 'source.fixAll': 'never' }, { overrideIdentifier: 'typescript' });
	assert.deepEqual(configuration.getValue(key, { overrideIdentifier: 'typescript' }), { 'source.fixAll': 'never' });
	assert.equal(configuration.getValue<Record<string, string>>(key)['source.fixAll'], 'explicit');
	await configuration.updateValue(key, ['source.fixAll']);
	assert.deepEqual(configuration.getValue(key), { 'source.fixAll': 'explicit' });
	const schema = createConfigurationSchema();
	for (const value of [null, 'always', [42], { 'source.fixAll': 'sometimes' }, { 'source.fixAll': 42 }]) {
		await assert.rejects(configuration.updateValue(key, value), TypeError);
		assert.ok(validateJsonSchema(parseJsonDocument(JSON.stringify({ [key]: value })), schema).length > 0);
	}
	await assert.rejects(configuration.updateValue('notebook.codeActionsOnSave', { 'notebook.source.fixAll': 'always' }), TypeError);
	await configuration.updateValue('notebook.codeActionsOnSave', { 'notebook.source.fixAll': true });
	assert.deepEqual(configuration.getValue('notebook.codeActionsOnSave'), { 'notebook.source.fixAll': 'explicit' });
	assert.deepEqual(validateJsonSchema(parseJsonDocument('{"editor.codeActionsOnSave":{"source.future":"always","source.fixAll":true}}'), schema), []);
});

test('Code Action save mode descriptions use the Chinese language pack', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	using reset = toDisposable(resetNlsResolver);
	const schema = createConfigurationSchema().properties!['editor.codeActionsOnSave'];
	assert.ok(schema.markdownDescription!.includes('保存文件'));
	assert.deepEqual((schema.additionalProperties as JsonSchema).enumDescriptions!.slice(0, 3), [
		'手动保存，以及因焦点或窗口切换而自动保存时运行。', '仅在手动保存时运行。', '保存时不运行。',
	]);
});

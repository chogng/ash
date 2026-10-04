import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { parseJsonDocument } from '../../../../../base/common/json.js';
import { validateJsonSchema, type JsonSchema } from '../../../../../base/common/jsonSchema.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { createTestCodeEditor, registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { pasteAsPreferenceConfig } from '../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { dropAsPreferenceConfig } from '../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createConfigurationSchema } from '../../../../../platform/configuration/common/configurationSchema.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { IPreferencesService, type IOpenSettingsOptions } from '../../../../services/preferences/common/preferences.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { DropOrPasteIntoCommands } from '../../browser/commands.js';
import { DropOrPasteSchemaContribution } from '../../browser/configurationSchema.js';
import '../../browser/dropOrPasteInto.contribution.js';
import '../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';

for (const mode of ['paste', 'drop'] as const) {
	test(`${mode} applies language-specific ordered preferences and opens its own settings from the selector`, async () => {
		const dom = new JSDOM('<body><main></main></body>');
		using close = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using services = new InstantiationService();
		registerCodeEditorServices(services);
		const opened: IOpenSettingsOptions[] = [];
		services.registerInstance(IPreferencesService, {
			openSettings: async () => {},
			openKeybindings: async () => {},
			openUserSettings: async options => { opened.push(options!); },
		});
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [DropOrPasteIntoCommands.ID]);
		host.advance(WorkbenchPhase.Eventually);
		const key = mode === 'paste' ? pasteAsPreferenceConfig : dropAsPreferenceConfig;
		const config = services.get(IConfigurationService);
		await config.updateValue(key, ['text']);
		await config.updateValue(key, ['unavailable', 'text.preferred'], { overrideIdentifier: 'plaintext' });
		const features = services.get(ILanguageFeaturesService);
		const kind = new HierarchicalKind('text.preferred.child');
		const edit = { title: 'Preferred', kind, insertText: 'PREFERRED', yieldTo: [{ mimeType: 'text/plain' }] };
		const selector = { language: 'plaintext', hasAccessToAllModels: true };
		using provider = mode === 'paste'
			? features.documentPasteEditProvider.register(selector, {
				copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
				provideDocumentPasteEdits: async () => ({ edits: [edit], dispose() {} }),
			})
			: features.documentDropEditProvider.register(selector, {
				dropMimeTypes: ['text/plain'], providedDropEditKinds: [kind],
				provideDocumentDropEdits: () => ({ edits: [edit], dispose() {} }),
			});
		using model = new TextModel('alpha');
		using editor = createTestCodeEditor({
			container: dom.window.document.querySelector<HTMLElement>('main')!,
			instantiationService: services, model, lineHeight: 20,
		});
		editor.setPosition({ lineNumber: 1, column: 6 });
		editor.layout({ width: 240, height: 40 });
		editor.getDomNode().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 40, width: 240, height: 40, toJSON() {} });
		const data = {
			types: ['text/plain'], files: [], getData: () => 'raw',
			items: [{
				kind: 'string', type: 'text/plain',
				getAsString: (callback: (text: string) => void) => callback('raw'), getAsFile: () => null,
			}],
		};
		const zh = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages(zh.locale, zh.bundles);
		using reset = toDisposable(resetNlsResolver);
		// A new widget resolves the current language instead of retaining its construction-time label.
		editor.controller.editContext.domNode.domNode.focus();
		const event = new dom.window.Event(mode, { bubbles: true, cancelable: true });
		Object.defineProperties(event, mode === 'paste'
			? { clipboardData: { value: data } }
			: { dataTransfer: { value: data }, clientX: { value: 80 }, clientY: { value: 10 } });
		(mode === 'paste' ? editor.controller.editContext.domNode.domNode : editor.getDomNode()).dispatchEvent(event);
		await waitFor(() => dom.window.document.querySelector('.stanza-editor-post-edit-selector') !== null);
		assert.equal(editor.getValue(), 'alphaPREFERRED');
		assert.equal(event.defaultPrevented, true);
		await services.get(ICommandService).executeCommand(mode === 'paste'
			? 'workbench.action.configurePreferredPasteAction'
			: 'workbench.action.configurePreferredDropAction');
		const trigger = dom.window.document.querySelector<HTMLButtonElement>('.stanza-editor-post-edit-selector button')!;
		trigger.click();
		const settingLabel = mode === 'paste' ? '配置首选粘贴方式...' : '配置首选拖放方式...';
		const setting = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
			.find(item => item.textContent === settingLabel)!;
		assert.ok(setting);
		setting.click();
		await waitFor(() => opened.length === 2);
		assert.deepEqual(opened, [{ revealSetting: { key, edit: true } }, { revealSetting: { key, edit: true } }]);
		host.dispose();
		assert.equal(CommandsRegistry.hasCommand('workbench.action.configurePreferredPasteAction'), false);
	});
}

test('schema tracks both provider registries, accepts unknown kinds, and removes keybinding suggestions on disposal', async () => {
	using services = new InstantiationService();
	registerCodeEditorServices(services);
	let additions: JsonSchema[] = [];
	let updates = 0;
	const base = services.get(IKeybindingService);
	const registerSchemaContribution = base.registerSchemaContribution;
	using restore = toDisposable(() => { base.registerSchemaContribution = registerSchemaContribution; });
	base.registerSchemaContribution = contribution => {
		additions = contribution.getSchemaAdditions();
		const listener = contribution.onDidChange?.(() => { additions = contribution.getSchemaAdditions(); updates++; });
		return toDisposable(() => { listener?.dispose(); additions = []; });
	};
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [DropOrPasteSchemaContribution.ID]);
	host.advance(WorkbenchPhase.Eventually);
	const features = services.get(ILanguageFeaturesService);
	const kind = new HierarchicalKind('text.extension');
	using paste = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind, kind],
		provideDocumentPasteEdits: async () => undefined,
	});
	using drop = features.documentDropEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		providedDropEditKinds: [kind], provideDocumentDropEdits: () => undefined,
	});
	const schema = createConfigurationSchema();
	const kinds = (key: string): readonly unknown[] => (schema.properties![key].items as JsonSchema).anyOf![1].enum!;
	assert.equal(kinds(pasteAsPreferenceConfig).filter(value => value === kind.value).length, 1);
	assert.ok(kinds(dropAsPreferenceConfig).includes(kind.value));
	assert.ok(JSON.stringify(additions).includes(kind.value));
	assert.equal(validateJsonSchema(parseJsonDocument('{"editor.pasteAs.preferences":["future.kind"]}'), schema).length, 0);
	await assert.rejects(services.get(IConfigurationService).updateValue(pasteAsPreferenceConfig, [42]), TypeError);
	paste.dispose();
	drop.dispose();
	assert.equal(kinds(pasteAsPreferenceConfig).includes(kind.value), false);
	assert.equal(kinds(dropAsPreferenceConfig).includes(kind.value), false);
	assert.equal(updates, 2);
	host.dispose();
	assert.deepEqual(additions, []);
});

for (const [args, expected] of [[{ preferences: ['missing', 'html', 'text'] }, '<b>markup</b>'], [undefined, 'plain']] as const) {
	test(`Paste As applies ${args ? 'ordered explicit preferences' : 'the plain-text command'} without a picker`, async () => {
		const dom = new JSDOM('<body><main></main></body>');
		using close = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		Object.defineProperty(dom.window.navigator, 'clipboard', {
			value: { read: async () => [{
				types: ['text/plain', 'text/html', 'text/uri-list'],
				getType: async (type: string) => new Blob([
					type === 'text/html' ? '<b>markup</b>' : type === 'text/uri-list' ? 'https://example.test/' : 'plain',
				], { type }),
			}] },
		});
		using model = new TextModel('old');
		using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
		editor.setSelection(new Selection(1, 1, 1, 4));
		editor.focus();
		await editor.invokeWithinContext(accessor => accessor.get(ICommandService).executeCommand(
			args ? 'editor.action.pasteAs' : 'editor.action.pasteAsText', ...(args ? [args] : []),
		));
		assert.equal(editor.getValue(), expected);
		assert.equal(dom.window.document.querySelector('[role=dialog]'), null);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= end) throw new Error('Expected drop/paste state was not reached');
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

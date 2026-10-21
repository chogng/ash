import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { FormattingConflicts, FormattingKind, FormattingMode } from '../../../../../editor/contrib/format/browser/format.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { DefaultFormatter } from '../../browser/formatActionsMultiple.js';
import '../../browser/format.contribution.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';

function createServices(configuration: TestConfigurationService) {
	const services = createTestEditorServices(configuration);
	services.registerSingleton(ICodeEditorService, () => new StandaloneCodeEditorService());
	return services;
}

const providers = ['Acme.First', 'Acme.Second'].map(id => ({
	extensionId: new ExtensionIdentifier(id), displayName: id, provideDocumentFormattingEdits: () => [],
}));

test('default formatter honors language overrides and extension identity without changing other languages', async () => {
	using configuration = new TestConfigurationService({ source: '{"editor.defaultFormatter":"Acme.First","[python]":{"editor.defaultFormatter":"acme.second"}}' });
	using services = createServices(configuration);
	using policy = services.createInstance(DefaultFormatter);
	using python = new TextModel('alpha', { languageId: 'python' });
	using rust = new TextModel('alpha', { languageId: 'rust' });
	assert.equal(await FormattingConflicts.select(providers, python, FormattingMode.Explicit, FormattingKind.File), providers[1]);
	assert.equal(await FormattingConflicts.select(providers, rust, FormattingMode.Silent, FormattingKind.File), providers[0]);
	assert.equal(services.get(IQuickInputService).currentQuickInput, undefined);
});

test('formatter conflict uses the window picker and persists its chosen language default', async () => {
	using configuration = new TestConfigurationService();
	using services = createServices(configuration);
	using policy = services.createInstance(DefaultFormatter);
	using model = new TextModel('alpha', { languageId: 'python' });
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Silent, FormattingKind.File), undefined);
	const selected = FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File);
	const quickInput = services.get(IQuickInputService);
	const picker = quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	assert.ok(picker);
	picker.activeItems = [picker.items[2] as IQuickPickItem];
	await quickInput.accept();
	picker.activeItems = [picker.items[1] as IQuickPickItem];
	await quickInput.accept();
	assert.equal(await selected, providers[1]);
	assert.equal(configuration.getValue(DefaultFormatter.configName, { overrideIdentifier: 'python' }), 'Acme.Second');
	assert.equal(configuration.getValue(DefaultFormatter.configName, { overrideIdentifier: 'rust' }), null);
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Silent, FormattingKind.File), providers[1]);
});

test('missing defaults never silently fall through and model disposal cancels an explicit choice', async () => {
	using configuration = new TestConfigurationService({ source: '{"editor.defaultFormatter":"missing.extension"}' });
	using services = createServices(configuration);
	using policy = services.createInstance(DefaultFormatter);
	using model = new TextModel('alpha');
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Silent, FormattingKind.File), undefined);
	const selected = FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File);
	model.dispose();
	assert.equal(await selected, undefined);
	assert.equal(configuration.getValue(DefaultFormatter.configName), 'missing.extension');
});

import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { after, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { createTestCodeEditor, registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { ColorDetector } from '../../../../../editor/contrib/colorPicker/browser/colorDetector.js';
import { FoldingController } from '../../../../../editor/contrib/folding/browser/folding.js';
import '../../../../../editor/contrib/colorPicker/browser/colorPickerContribution.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { LimitIndicatorContribution } from '../../browser/limitIndicator.contribution.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import '../../../../../editor/common/config/editorConfigurationSchema.js';

test('real color and folding limits update one status entry and release old model listeners', async () => {
	using resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	resources.add(toDisposable(() => dom.window.close()));
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const services = resources.add(new InstantiationService());
	const changed = resources.add(new Emitter<void>());
	services.registerInstance(IEditorService, { onDidActiveEditorChange: changed.event } as IEditorService);
	const statusbar = resources.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	const commands: unknown[][] = [];
	services.registerInstance(ICommandService, {
		onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
		executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => { commands.push([id, ...args]); return undefined as T; },
	});
	registerCodeEditorServices(services);
	const features = resources.add(new LanguageFeaturesService());
	resources.add(features.colorProvider.register('*', {
		provideDocumentColors: () => [1, 6, 11].map(column => ({ range: new Range(5, column, 5, column + 4), color: { red: 1, green: 0, blue: 0, alpha: 1 } })),
		provideColorPresentations: () => [],
	}));
	const model = resources.add(new TextModel('first\n  child\nsecond\n  child\n#f00 #f00 #f00'));
	const editor = resources.add(createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features, instantiationService: services }));
	editor.updateOptions({ colorDecoratorsLimit: 1, foldingMaximumRegions: 1, foldingStrategy: 'indentation' });
	editor.layout({ width: 500, height: 180 });
	editor.focus();
	const contribution = resources.add(services.createInstance(LimitIndicatorContribution));
	await waitFor(() => ColorDetector.get(editor)?.limitReporter.computed === 3 && statusbar.getEntries(StatusbarAlignment.Right).length === 1);
	const entry = () => statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry;
	assert.equal(ColorDetector.get(editor)?.limitReporter.computed, 3);
	assert.equal(FoldingController.get(editor)?.limitReporter.computed, 2);
	assert.match(entry()!.tooltip!, /Only 1 of 3 color decorations/);
	assert.match(entry()!.tooltip!, /Only 1 of 2 folding regions/);
	await entry()!.run!();
	assert.deepEqual(commands, [['workbench.action.openSettings', '@id:editor.colorDecoratorsLimit']]);
	editor.updateOptions({ colorDecoratorsLimit: 10, foldingMaximumRegions: 10 });
	await waitFor(() => statusbar.getEntries(StatusbarAlignment.Right).length === 0);
	const plain = resources.add(new TextModel('plain'));
	editor.setModel(plain);
	changed.fire();
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	contribution.dispose();
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
});

test('limit contribution requires the production service registrations', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(LimitIndicatorContribution), /Unknown service/);
});

test('folding budget configuration rejects invalid values and preserves the last valid value', async () => {
	using configuration = new InMemoryConfigurationService();
	assert.equal(configuration.getValue('editor.foldingMaximumRegions'), 5000);
	await configuration.updateValue('editor.foldingMaximumRegions', 1);
	for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(configuration.updateValue('editor.foldingMaximumRegions', value), /positive integer/);
		assert.equal(configuration.getValue('editor.foldingMaximumRegions'), 1);
	}
});

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'limit state reaches the status bar');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

const features = registerTestCodeEditorFeatures(['editor.contrib.colorPicker', 'editor.contrib.folding']);
after(() => features.dispose());

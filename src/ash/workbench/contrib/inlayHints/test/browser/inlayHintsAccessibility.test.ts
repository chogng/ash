import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { after, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { createTestCodeEditor, registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { InlayHintsController } from '../../../../../editor/contrib/inlayHints/browser/inlayHintsController.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewProviderId, AccessibleViewType, IAccessibleViewService, type IAccessibleViewContentProvider } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import '../../browser/inlayHintsAccessibilty.js';

test('reads current sorted hints in Chinese without changing text and discards hints after an edit', async () => {
	using resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	resources.add(toDisposable(() => dom.window.close()));
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const services = resources.add(new InstantiationService());
	registerCodeEditorServices(services);
	const features = resources.add(new LanguageFeaturesService());
	const model = resources.add(new TextModel('call(42);'));
	let requests = 0;
	resources.add(features.inlayHintsProvider.register('*', {
		provideInlayHints: () => {
			requests++;
			return [{ position: new Position(1, 9), label: [{ value: ': void' }] }, { position: new Position(1, 6), label: 'value:' }];
		},
	}));
	let provider: IAccessibleViewContentProvider | undefined;
	services.registerInstance(IAccessibleViewService, {
		show: type => {
			provider = AccessibleViewRegistry.getImplementations().filter(value => value.type === type).map(value => services.invokeFunction(accessor => value.getProvider(accessor))).find(value => value?.id === AccessibleViewProviderId.InlayHints);
			return provider !== undefined;
		},
		getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, ...toDisposable(() => { }),
	});
	const editor = resources.add(createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features, instantiationService: services }));
	editor.layout({ width: 500, height: 160 });
	editor.focus();
	assert.equal(services.get(ICodeEditorService).getFocusedCodeEditor(), editor);
	await waitFor(() => InlayHintsController.get(editor)?.getInlayHintsForLine(1).length === 2);
	initializeTestLocalization('zh-CN');
	try {
		assert.ok(editor.getSupportedActions().some(action => action.id === 'inlayHints.startReadingLineWithHint'));
		await editor.getAction('inlayHints.startReadingLineWithHint')!.run();
		assert.equal(provider!.provideContent(), '第 1 行（含内联提示）：\ncall( value: 42) : void ;');
		assert.equal(requests, 1);
		assert.equal(model.getValue(), 'call(42);');
		let changes = 0;
		resources.add(provider!.onDidChangeContent!(() => changes++));
		model.setValue('changed');
		assert.equal(changes, 1);
		assert.equal(provider!.provideContent(), '第 1 行（含内联提示）：\nchanged');
		provider!.dispose();
		assert.equal(editor.hasTextFocus(), true);
	} finally {
		resetNlsResolver();
	}
});

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'hint provider completes');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

const features = registerTestCodeEditorFeatures(['editor.contrib.inlayHints']);
after(() => features.dispose());

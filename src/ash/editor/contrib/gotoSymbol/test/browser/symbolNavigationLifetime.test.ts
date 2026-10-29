import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FontMeasurements } from '../../../../browser/config/fontMeasurements.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { Range } from '../../../../common/core/range.js';
import { URI } from '../../../../../base/common/uri.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ICodeEditorService } from '../../../../browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../standalone/browser/standaloneCodeEditorService.js';
import { ILanguageFeaturesService } from '../../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { createTestCodeEditor } from '../../../../test/browser/testCodeEditor.js';
import { ReferencesModel } from '../../browser/referencesModel.js';
import type { ISymbolNavigationService } from '../../browser/symbolNavigation.js';
import type { IEditorContribution } from '../../../../common/editorCommon.js';

suite('Symbol navigation provider lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('one window shares its navigation session across editors and retires every context binding', async () => {
		using features = registerTestCodeEditorFeatures(['editor.contrib.symbolNavigation']);
		const dom = new JSDOM('<body><main id="first"></main><main id="second"></main></body>');
		using close = toDisposable(() => {
			FontMeasurements.dispose();
			dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
			dom.window.close();
		});
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using services = new InstantiationService();
		using editors = new StandaloneCodeEditorService();
		using languages = new LanguageFeaturesService();
		services.registerInstance(ICodeEditorService, editors);
		services.registerInstance(ILanguageFeaturesService, languages);
		using first = new TextModel('alpha beta', { resource: URI.file('/first.ts') });
		using second = new TextModel('alpha beta', { resource: URI.file('/second.ts') });
		using firstEditor = createTestCodeEditor({
			container: dom.window.document.getElementById('first')!,
			model: first,
			instantiationService: services,
			minimap: { enabled: false },
		});
		using secondEditor = createTestCodeEditor({
			container: dom.window.document.getElementById('second')!,
			model: second,
			instantiationService: services,
			minimap: { enabled: false },
		});
		type Navigation = IEditorContribution & { readonly service: ISymbolNavigationService };
		const firstService = firstEditor.getContribution<Navigation>('editor.contrib.symbolNavigation')!.service;
		const secondService = secondEditor.getContribution<Navigation>('editor.contrib.symbolNavigation')!.service;
		assert.strictEqual(firstService, secondService);
		using references = new ReferencesModel(
			[
				{ uri: first.uri, range: new Range(1, 1, 1, 6) },
				{ uri: second.uri, range: new Range(1, 7, 1, 11) },
			],
			'references',
		);
		secondEditor.focus();
		firstService.put(references.references.find(reference => reference.uri.toString() === first.uri.toString())!);
		assert.equal(secondEditor.getAction('editor.gotoNextSymbolFromResult')!.isSupported(), true);
		await secondEditor.getAction('editor.gotoNextSymbolFromResult')!.run();
		assert.deepEqual(secondEditor.getSelection(), new (await import('../../../../common/core/selection.js')).Selection(1, 7, 1, 11));
		features.dispose();
		assert.equal(secondEditor.getContribution('editor.contrib.symbolNavigation'), null);
		assert.equal(
			secondEditor.invokeWithinContext(accessor => accessor.get(IContextKeyService).getContext().getValue('hasSymbols')),
			false,
		);
		assert.equal(first.getText(), 'alpha beta');
		assert.equal(second.getText(), 'alpha beta');
	});
});

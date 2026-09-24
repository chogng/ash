import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Range } from '../../../common/core/range.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../standalone/browser/standaloneCodeEditorService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { createTestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../common/services/languageFeaturesService.js';
import { IContextKeyService, ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ServiceContainer } from '../../../../platform/instantiation/common/instantiation.js';
import { installEditorTestDom } from '../editorTestGlobals.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
], { ResizeObserver: TestResizeObserver });

await import('../../../contrib/diffEditorBreadcrumbs/browser/contribution.js');
const { DiffEditorWidget } = await import('../../../browser/widget/diffEditor/diffEditorWidget.js');
const { DiffModel } = await import('../../../common/diff/diffModel.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});
const diffOptions: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

const enabledAccessibilityService: IAccessibilityService = {
	onDidChangeScreenReaderOptimized: Event.None,
	onDidChangeReducedMotion: Event.None,
	onDidChangeReducedTransparency: Event.None,
	onDidChangeLinkUnderlines: Event.None,
	alwaysUnderlineAccessKeys: async () => false,
	isScreenReaderOptimized: () => true,
	isMotionReduced: () => false,
	isTransparencyReduced: () => false,
	getAccessibilitySupport: () => AccessibilitySupport.Enabled,
	setAccessibilitySupport: () => {},
	alert: () => {},
	status: () => {},
};

test('DiffEditorWidget owns two editors, keeps source models caller-owned, and refreshes decorations after an edit', async () => {
	using services = createServices();
	using original = new TextModel('same\nold value\ntail');
	using modified = new TextModel('same\nnew value\ntail');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	const codeEditorService = services.get(ICodeEditorService);
	const lifecycle: string[] = [];
	using added = codeEditorService.onDiffEditorAdd(() => lifecycle.push('add'));
	using removed = codeEditorService.onDiffEditorRemove(() => lifecycle.push('remove'));
	const editor = services.createInstance(DiffEditorWidget, { container, model, lineHeight: 20 });
	editor.layout({ width: 400, height: 80 });

	assert.deepEqual(lifecycle, ['add']);
	assert.deepEqual(codeEditorService.listDiffEditors(), [editor]);
	assert.equal(editor.originalEditor.getModel(), original);
	assert.equal(editor.modifiedEditor.getModel(), modified);
	assert.equal(editor.originalEditor.getOption(EditorOption.readOnly), true);
	assert.equal(editor.modifiedEditor.getOption(EditorOption.readOnly), false);
	assert.equal(editor.originalEditor.getOption(EditorOption.scrollBeyondLastLine), true);
	assert.equal(editor.element.querySelectorAll('.stanza-editor').length, 2);
	assert.equal(original.getAllDecorations().some(decoration => decoration.options.className === 'stanza-diff-line-removed'), true);
	assert.equal(modified.getAllDecorations().some(decoration => decoration.options.inlineClassName === 'stanza-diff-inline-added'), true);
	assert.equal(editor.nextChange(), 1);
	assert.match(editor.element.querySelector('.stanza-diff-editor-accessibility-status')?.textContent ?? '', /Change 1 of 1/);

	modified.applyEdits([{ range: new Range(2, 1, 2, 10), text: 'old value' }]);
	await waitForReady(model);
	assert.equal(editor.diff?.hunks.length, 0);
	assert.equal(modified.getAllDecorations().some(decoration => decoration.options.className === 'stanza-diff-line-added'), false);
	editor.dispose();
	assert.deepEqual(lifecycle, ['add', 'remove']);
	assert.deepEqual(codeEditorService.listDiffEditors(), []);
	assert.equal(original.isDisposed(), false);
	assert.equal(modified.isDisposed(), false);
});

test('DiffEditorWidget inserts paired view space for added lines and navigates without wrapping when requested', async () => {
	using services = createServices();
	using original = new TextModel('first\nlast\nold end');
	using modified = new TextModel('first\ninserted\nlast\nnew end');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, {
		container,
		model,
		lineHeight: 20,
		wordWrap: false,
		loopChanges: false,
		readOnly: true,
	});
	editor.layout({ width: 400, height: 80 });

	assert.equal(editor.modifiedEditor.getOption(EditorOption.readOnly), true);
	assert.equal(editor.originalEditor.getTopForLineNumber(2), editor.modifiedEditor.getTopForLineNumber(3));
	assert.equal(editor.nextChange(), 1);
	assert.equal(editor.nextChange(), 3);
	assert.equal(editor.nextChange(), 3);
	assert.equal(editor.previousChange(), 1);
	editor.toggleWordWrap();
	assert.equal(editor.wordWrap, true);
	assert.equal(editor.originalEditor.getOption(EditorOption.wordWrap), 'on');
	assert.equal(editor.modifiedEditor.getOption(EditorOption.wordWrap), 'on');
	assert.equal(editor.element.classList.contains('word-wrapped'), true);
});

test('DiffEditorWidget hides paired unchanged lines and reveals them from either side', async () => {
	using services = createServices();
	const lines = Array.from({ length: 36 }, (_, index) => `line ${index + 1}`);
	using original = new TextModel(lines.join('\n'));
	using modified = new TextModel([...lines.slice(0, -1), 'changed line'].join('\n'));
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, {
		container,
		model,
		hideUnchangedRegions: { enabled: true, contextLineCount: 1, minimumLineCount: 3, revealLineCount: 2 },
	});
	editor.layout({ width: 800, height: 600 });

	assert.equal(editor.element.querySelectorAll('.ash-diff-hidden-region').length, 2);
	assert.equal(editor.originalEditor.getVisibleRanges().some(range => range.startLineNumber <= 5 && 5 <= range.endLineNumber), false);
	(editor.element.querySelector('.ash-diff-hidden-region button') as HTMLButtonElement).click();
	assert.equal(editor.element.querySelector('.ash-diff-hidden-region-count')?.textContent, '31 hidden lines');
	(editor.element.querySelectorAll('.ash-diff-hidden-region button')[1] as HTMLButtonElement).click();
	assert.equal(editor.element.querySelectorAll('.ash-diff-hidden-region').length, 0);
	assert.equal(editor.originalEditor.getVisibleRanges().some(range => range.startLineNumber <= 5 && 5 <= range.endLineNumber), true);
});

function createServices(): ServiceContainer {
	const services = new ServiceContainer();
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IThemeService, new TestThemeService(darkColorTheme));
	services.registerInstance(ILanguageConfigurationService, createTestLanguageConfigurationService());
	services.registerInstance(ILanguageFeaturesService, new LanguageFeaturesService());
	services.registerInstance(IAccessibilityService, enabledAccessibilityService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
	return services;
}

class WidgetTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return { identical: original.getValue() === modified.getValue(), quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function waitForReady(model: InstanceType<typeof DiffModel>): Promise<void> {
	if (model.state.kind === 'ready') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const listener = model.onDidChange(state => {
			if (state.kind === 'loading') return;
			listener.dispose();
			if (state.kind === 'error') reject(state.error);
			else resolve();
		});
	});
}

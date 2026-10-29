import { registerTestCodeEditorFeatures } from '../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Range } from '../../../common/core/range.js';
import { TokenizationRegistry, type IState } from '../../../common/languages.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { SyntaxProviderRegistry } from '../../../common/languageFeatureRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../standalone/browser/standaloneCodeEditorService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { getIconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { createTestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../common/services/languageFeaturesService.js';
import { IContextKeyService, ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { installEditorTestDom } from '../editorTestGlobals.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const installedGlobals = installEditorTestDom(browserEnvironment, ['Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent'], { ResizeObserver: TestResizeObserver });
setIconResolver(browserEnvironment.window.document, icon => getIconDefinition(icon));

await import('../../../contrib/diffEditorBreadcrumbs/browser/contribution.js');
const { DiffEditorWidget } = await import('../../../browser/widget/diffEditor/diffEditorWidget.js');
const { DiffModel } = await import('../../../common/diff/diffModel.js');
const { registerCodeEditorServices } = await import('../testCodeEditor.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});
const diffOptions: IDocumentDiffProviderOptions = {
	ignoreTrimWhitespace: false,
	maxComputationTimeMs: 0,
	computeMoves: false,
};

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

test('DiffEditorWidget colors inline removed lines and refreshes their tokens without replacing the accessible zone', async () => {
	using services = createServices();
	using providers = new SyntaxProviderRegistry();
	let tokenType = 'keyword';
	using registration = providers.register({
		id: 'test.diff-colors',
		languageIds: ['diff-colors'],
		provideTokens: () => ({ tokens: [{ range: new Range(1, 1, 1, 7), tokenType, modifiers: [] }] }),
	});
	using original = new TextModel('before', {
		languageId: 'diff-colors',
		tokenization: { syntaxProviderRegistry: providers },
	});
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, { container, model, renderSideBySide: false });
	editor.layout({ width: 400, height: 80 });
	await original.tokenization.whenReady(new AbortController().signal);
	const removedLine = editor.element.querySelector('.stanza-diff-inline-original-line');
	assert.ok(removedLine);
	assert.equal(removedLine.textContent, 'before');
	assert.equal(removedLine.getAttribute('aria-label'), 'Removed line 1: before');
	assert.equal([...removedLine.querySelectorAll('.token-keyword')].map(token => token.textContent).join(''), 'before');
	assert.equal([...removedLine.querySelectorAll('.stanza-diff-inline-removed')].map(token => token.textContent).join(''), 'before');

	const unchangedToken = removedLine.firstElementChild;
	original.deltaDecorations(
		[],
		[
			{
				range: new Range(1, 1, 1, 7),
				options: { description: 'unrelated margin', linesDecorationsClassName: 'unrelated-margin' },
			},
		],
	);
	assert.strictEqual(removedLine.firstElementChild, unchangedToken);

	let decorationQueries = 0;
	let decorationChanges = 0;
	using decorationListener = editor.originalEditor.onDidChangeModelDecorations(() => {
		decorationChanges += 1;
	});
	const getLineDecorations = editor.originalEditor.getLineDecorations.bind(editor.originalEditor);
	editor.originalEditor.getLineDecorations = lineNumber => {
		decorationQueries += 1;
		return getLineDecorations(lineNumber);
	};
	tokenType = 'string';
	original.tokenization.resetTokenization();
	await original.tokenization.whenReady(new AbortController().signal);
	assert.strictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), removedLine);
	assert.equal(removedLine.querySelector('.token-keyword'), null);
	assert.equal([...removedLine.querySelectorAll('.token-string')].map(token => token.textContent).join(''), 'before');
	// Resetting tokenization may also refresh bracket decorations; only those
	// owner notifications should query this row's decorations again.
	assert.equal(decorationQueries, decorationChanges);
	const [decorationId] = original.deltaDecorations(
		[],
		[
			{
				range: new Range(1, 1, 1, 2),
				options: { description: 'inline change', inlineClassName: 'changed-inline-decoration' },
			},
		],
	);
	assert.ok(decorationQueries > 0);
	assert.equal(removedLine.querySelector('.changed-inline-decoration')?.textContent, 'b');
	original.deltaDecorations([decorationId], []);
	assert.equal(removedLine.querySelector('.changed-inline-decoration'), null);
});

test('inline token batches refresh only deleted rows in the changed range', async () => {
	using services = createServices();
	const state: IState = { clone: () => state, equals: other => other === state };
	using registration = TokenizationRegistry.register('diff-ranges', {
		getInitialState: () => state,
		tokenize: (_line, _hasEOL, state) => ({
			tokens: [{ offset: 0, type: 'keyword', language: 'diff-ranges' }],
			endState: state,
		}),
	});
	using original = new TextModel(Array.from({ length: 200 }, (_, index) => `before ${index}`).join('\n'), {
		languageId: 'diff-ranges',
	});
	using modified = new TextModel(Array.from({ length: 200 }, (_, index) => `after ${index}`).join('\n'));
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
		renderSideBySide: false,
	});
	editor.layout({ width: 400, height: 80 });
	const lines = editor.element.querySelectorAll('.stanza-diff-inline-original-line');
	assert.equal(lines.length, 200);
	const retainedSpan = lines[10]!.firstElementChild;
	const source = original.tokenization.renderedTokens;
	const getLineTokens = source.getLineTokens.bind(source);
	const queries: number[] = [];
	source.getLineTokens = lineIndex => {
		queries.push(lineIndex);
		return getLineTokens(lineIndex);
	};
	try {
		original.tokenization.setVisibleLines([{ startLineNumber: 100, endLineNumber: 104 }]);
		assert.deepEqual(queries, [99, 100, 101, 102, 103]);
		assert.strictEqual(lines[10]!.firstElementChild, retainedSpan);
		for (let index = 99; index <= 103; index++) {
			assert.equal([...lines[index]!.querySelectorAll('.token-keyword')].map(token => token.textContent).join(''), `before ${index}`);
		}
	} finally {
		source.getLineTokens = getLineTokens;
	}
});

test('inline removed lines follow semantic theme styles and coloring settings while retaining their difference marks', async () => {
	using services = createServices();
	using providers = new SyntaxProviderRegistry();
	using syntax = providers.register({
		id: 'test.diff-theme',
		languageIds: ['diff-theme'],
		provideTokens: () => ({
			tokens: [
				{
					range: new Range(1, 1, 1, 7),
					tokenType: 'keyword',
					modifiers: [],
					presentation: { foreground: '#0000ff' },
				},
			],
		}),
	});
	const features = services.get(ILanguageFeaturesService);
	let semanticType = 'variable';
	using semantic = features.documentSemanticTokensProvider.register('diff-theme', {
		provideSemanticTokens: () => ({
			tokens: [{ range: new Range(1, 1, 1, 7), tokenType: semanticType, modifiers: [] }],
		}),
	});
	using original = new TextModel('before', {
		languageId: 'diff-theme',
		tokenization: {
			syntaxProviderRegistry: providers,
			documentSemanticTokensProvider: features.documentSemanticTokensProvider,
		},
	});
	using modified = new TextModel('after');
	await original.tokenization.whenReady(new AbortController().signal);
	await original.tokenization.semanticTokens!.requestTokens('diff-theme');
	const themes = services.get(IThemeService) as TestThemeService;
	const theme = {
		...darkColorTheme,
		semanticHighlighting: true,
		tokenColorMap: ['', '#ff0000'],
		getTokenStyleMetadata: () => ({ foreground: 1, bold: true }),
	};
	themes.setColorTheme(theme);
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
		renderSideBySide: false,
	});
	editor.layout({ width: 400, height: 80 });
	const removedLine = editor.element.querySelector('.stanza-diff-inline-original-line')!;
	const style = () => {
		const token = removedLine.querySelector<HTMLElement>('.stanza-editor-token')!;
		return [token.style.getPropertyValue('--ash-editor-token-foreground'), token.style.fontWeight];
	};
	assert.deepEqual(style(), ['#ff0000', 'bold']);
	semanticType = 'string';
	await original.tokenization.semanticTokens!.requestTokens('diff-theme');
	assert.equal(removedLine.querySelector<HTMLElement>('.stanza-editor-token')!.dataset.ashSemanticType, 'string');
	themes.setColorTheme({ ...theme, tokenColorMap: ['', '#00ff00'] });
	assert.strictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), removedLine);
	assert.deepEqual(style(), ['#00ff00', 'bold']);
	await services.get(IConfigurationService).updateValue('editor.semanticHighlighting.enabled', false);
	assert.deepEqual(style(), ['', '']);
	assert.equal([...removedLine.querySelectorAll('.stanza-diff-inline-removed')].map(token => token.textContent).join(''), 'before');
});

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
	assert.equal(
		original.getAllDecorations().some(decoration => decoration.options.className === 'stanza-diff-line-removed'),
		true,
	);
	assert.equal(
		modified.getAllDecorations().some(decoration => decoration.options.className === 'stanza-diff-inline-added'),
		true,
	);
	assert.equal(editor.nextChange(), 1);
	assert.match(editor.element.querySelector('.stanza-diff-editor-accessibility-status')?.textContent ?? '', /Change 1 of 1/);

	modified.applyEdits([{ range: new Range(2, 1, 2, 10), text: 'old value' }]);
	await waitForReady(model);
	assert.equal(editor.diff?.hunks.length, 0);
	assert.equal(
		modified.getAllDecorations().some(decoration => decoration.options.className === 'stanza-diff-line-added'),
		false,
	);
	editor.dispose();
	assert.deepEqual(lifecycle, ['add', 'remove']);
	assert.deepEqual(codeEditorService.listDiffEditors(), []);
	assert.equal(original.isDisposed(), false);
	assert.equal(modified.isDisposed(), false);
});

test('DiffEditorWidget applies the split ratio and disables its separator when resizing is off', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, {
		container,
		model,
		splitViewDefaultRatio: 0.3,
		enableSplitViewResizing: false,
	});
	editor.layout({ width: 530, height: 80 });
	assert.equal(editor.element.style.getPropertyValue('--ash-diff-center-width'), '35px');
	assert.equal(editor.element.style.getPropertyValue('--stanza-diff-original-width'), '115px');
	const sash = editor.element.querySelector('.stanza-diff-sash');
	assert.equal(sash?.getAttribute('aria-disabled'), 'true');
	assert.equal(sash?.getAttribute('aria-valuenow'), '30');
	assert.equal((sash as HTMLElement).hidden, true);
	editor.setSplitViewOptions(true, 0.4);
	assert.equal(editor.element.style.getPropertyValue('--stanza-diff-original-width'), '165px');
	assert.equal(sash?.getAttribute('aria-disabled'), 'false');
	editor.setSplitViewOptions(true, 0.5);
	editor.layout({ width: 531, height: 80 });
	assert.equal(editor.element.style.getPropertyValue('--stanza-diff-original-width'), '215px');
	assert.throws(() => editor.setSplitViewOptions(true, 1), /between 0.1 and 0.9/);
});

test('DiffEditorWidget retains exact keyboard sash steps across ratio round trips and resize', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, { container, model });
	editor.layout({ width: 800, height: 80 });
	const sash = editor.element.querySelector<HTMLElement>('.stanza-diff-sash')!;
	const originalWidth = () => Number.parseFloat(editor.element.style.getPropertyValue('--stanza-diff-original-width'));
	const initial = originalWidth();
	const press = (key: string, altKey = false) => sash.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key, altKey, bubbles: true }));
	press('ArrowRight');
	assert.equal(originalWidth(), initial + 10);
	press('ArrowLeft', true);
	assert.equal(originalWidth(), initial + 9);
	for (let iteration = 0; iteration < 10; iteration++) {
		press('ArrowRight', true);
		assert.equal(originalWidth(), initial + 10);
		press('ArrowLeft', true);
		assert.equal(originalWidth(), initial + 9);
	}
	editor.layout({ width: 1031, height: 80 });
	assert.equal(originalWidth(), 477);
	sash.dispatchEvent(new browserEnvironment.window.Event('dblclick', { bubbles: true }));
	assert.equal(originalWidth(), 465);
});

test('DiffEditorWidget retains unwrapped alignment zones and accessible inline deletions across resizes', async () => {
	using services = createServices();
	using original = new TextModel('first\nremoved\nlast');
	using modified = new TextModel('first\nlast');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, { container, model, wordWrap: 'off', lineHeight: 20 });
	editor.layout({ width: 800, height: 200 });
	const zone = editor.element.querySelector('.ash-diff-alignment-zone');
	assert.ok(zone);
	editor.layout({ width: 780, height: 200 });
	assert.strictEqual(editor.element.querySelector('.ash-diff-alignment-zone'), zone);
	assert.equal(editor.originalEditor.getTopForLineNumber(3), editor.modifiedEditor.getTopForLineNumber(2));
	editor.setViewMode(false, false, 900);
	const deletion = editor.element.querySelector('.stanza-diff-inline-original-line');
	assert.ok(deletion);
	assert.equal(deletion.getAttribute('aria-label'), 'Removed line 2: removed');
	editor.layout({ width: 760, height: 180 });
	assert.strictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), deletion);
	editor.modifiedEditor.updateOptions({ lineHeight: 24 });
	editor.layout({ width: 760, height: 180 });
	assert.notStrictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), deletion);
	modified.setValue('first\nreplacement\nlast');
	await waitForReady(model);
	assert.equal(editor.element.querySelector('.stanza-diff-inline-original-line')?.textContent, 'removed');
	assert.equal(editor.modifiedEditor.getModel()!.getLineContent(2), 'replacement');
});

test('inline diff aligns both number columns through deletions, additions and layout changes', async () => {
	using services = createServices();
	using original = new TextModel('first\nremoved\nlast');
	using modified = new TextModel('first\nlast\nadded');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
		renderSideBySide: false,
		lineHeight: 20,
		scrollBeyondLastLine: false,
	});
	editor.layout({ width: 500, height: 40 });
	assert.equal(editor.originalEditor.getTopForLineNumber(3), editor.modifiedEditor.getTopForLineNumber(2));
	assert.equal(editor.originalEditor.getContentHeight(), editor.modifiedEditor.getContentHeight());
	assert.equal(editor.element.querySelector('.original')?.getAttribute('aria-hidden'), 'true');
	assert.ok(editor.element.querySelector('.original .stanza-editor-margin-view-zone.stanza-diff-gutter-added'));
	const inlineNumbersWidth = editor.modifiedEditor.getLayoutInfo().lineNumbersWidth;
	editor.modifiedEditor.setScrollTop(20);
	assert.equal(editor.originalEditor.getScrollTop(), editor.modifiedEditor.getScrollTop());
	editor.setViewMode(true, false, 900);
	assert.ok(editor.modifiedEditor.getLayoutInfo().lineNumbersWidth < inlineNumbersWidth);
	assert.equal(editor.element.querySelector('.original')?.getAttribute('aria-hidden'), 'false');
	editor.setViewMode(false, false, 900);
	assert.equal(editor.modifiedEditor.getLayoutInfo().lineNumbersWidth, inlineNumbersWidth);
	assert.equal(editor.originalEditor.getTopForLineNumber(3), editor.modifiedEditor.getTopForLineNumber(2));
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
		wordWrap: 'off',
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
	assert.equal(
		editor.originalEditor.getVisibleRanges().some(range => range.startLineNumber <= 5 && 5 <= range.endLineNumber),
		false,
	);
	assert.equal(editor.element.querySelector('.ash-diff-hidden-region-count')?.textContent, '34 hidden lines');
	(editor.element.querySelector('.ash-diff-hidden-region-above') as HTMLButtonElement).click();
	assert.equal(editor.element.querySelector('.ash-diff-hidden-region-count')?.textContent, '32 hidden lines');
	(editor.element.querySelector('.ash-diff-hidden-region-disclosure button') as HTMLButtonElement).click();
	assert.equal(editor.element.querySelectorAll('.ash-diff-hidden-region').length, 0);
	assert.equal(
		editor.originalEditor.getVisibleRanges().some(range => range.startLineNumber <= 5 && 5 <= range.endLineNumber),
		true,
	);
	assert.equal(editor.element.querySelectorAll('.ash-diff-fold-unchanged').length, 2);
	(editor.modifiedEditor.getDomNode().querySelector('.ash-diff-fold-unchanged button') as HTMLButtonElement).click();
	assert.equal(editor.element.querySelectorAll('.ash-diff-fold-unchanged').length, 0);
	assert.equal(editor.element.querySelectorAll('.ash-diff-hidden-region').length, 2);
	assert.equal(editor.element.querySelector('.ash-diff-hidden-region-count')?.textContent, '34 hidden lines');
	assert.equal(
		editor.modifiedEditor.getVisibleRanges().some(range => range.startLineNumber <= 5 && 5 <= range.endLineNumber),
		false,
	);
	assert.equal(original.getValue(), lines.join('\n'));
});

for (const [originalText, modifiedText] of [
	['first\nlast', 'first\nadded\nlast'],
	['first\nremoved\nlast', 'first\nlast'],
	['first', 'first\nadded'],
	['first\nremoved', 'first'],
	['old', 'new'],
	['first\r\nold', 'first\r\nnew'],
	['', 'added'],
	['removed', ''],
	['first\n', 'first'],
]) {
	test(`DiffEditorWidget reverts a hunk and restores it with undo: ${JSON.stringify([originalText, modifiedText])}`, async () => {
		using services = createServices();
		using original = new TextModel(originalText);
		using modified = new TextModel(modifiedText);
		using computation = new WidgetTestDiffComputationService();
		using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
		await waitForReady(model);
		using editor = services.createInstance(DiffEditorWidget, {
			container: browserEnvironment.window.document.createElement('main'),
			model,
		});
		editor.revert(model.diff!.changes[0]!);
		await waitForReady(model);
		assert.equal(modified.getValue(), originalText);
		modified.undo();
		assert.equal(modified.getValue(), modifiedText);
	});
}

test('DiffEditorWidget rejects stale hunk and character edits while recomputing and after a newer result', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
	});
	const stale = model.diff!.changes[0]!;
	model.refresh();
	editor.revert(stale);
	editor.revertRangeMappings([...stale.innerChanges!]);
	assert.equal(modified.getValue(), 'after');
	await waitForReady(model);
	editor.revert(stale);
	editor.revertRangeMappings([...stale.innerChanges!]);
	assert.equal(modified.getValue(), 'after');
	editor.updateOptions({ readOnly: true });
	editor.revert(model.diff!.changes[0]!);
	assert.equal(modified.getValue(), 'after');
});

test('DiffEditorWidget uses registered presentation defaults and preserves explicit option overrides', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
	});
	const configuration = services.get(IConfigurationService);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 1);
	await configuration.updateValue('diffEditor.renderMarginRevertIcon', false);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 1);
	await configuration.updateValue('diffEditor.renderGutterMenu', false);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 0);
	editor.setViewMode(true, false, 900);
	editor.updateOptions({ renderMarginRevertIcon: true });
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 1);
	editor.setViewMode(false, false, 900);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 0);
	await configuration.updateValue('diffEditor.renderOverviewRuler', false);
	assert.equal((editor.element.querySelector('.stanza-diff-overview') as HTMLElement).hidden, true);
	await assert.rejects(configuration.updateValue('diffEditor.experimental.showMoves', 'yes'), /boolean/);
});

test('DiffEditorWidget honors creation indicators and keeps their override across configuration changes', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, {
		container: browserEnvironment.window.document.createElement('main'),
		model,
		renderSideBySide: false,
		renderIndicators: false,
	});
	editor.layout({ width: 400, height: 80 });
	const configuration = services.get(IConfigurationService);
	assert.equal(configuration.getValue('diffEditor.renderIndicators'), true);
	assert.equal(editor.element.querySelector('.ash-diff-inline-original-margin .ash-icon'), null);
	await configuration.updateValue('diffEditor.renderIndicators', false);
	await configuration.updateValue('diffEditor.renderIndicators', true);
	assert.equal(editor.element.querySelector('.ash-diff-inline-original-margin .ash-icon'), null);
	editor.updateOptions({ renderIndicators: true });
	assert.equal(editor.element.querySelectorAll('.ash-diff-inline-original-margin .ash-icon').length, 1);
	await assert.rejects(configuration.updateValue('diffEditor.renderIndicators', 'yes'), /boolean/);
});

function createServices(): InstantiationService {
	const services = new InstantiationService();
	services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IThemeService, new TestThemeService(darkColorTheme));
	services.registerInstance(ILanguageConfigurationService, createTestLanguageConfigurationService());
	services.registerInstance(ILanguageFeaturesService, new LanguageFeaturesService());
	services.registerInstance(IAccessibilityService, enabledAccessibilityService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
	registerCodeEditorServices(services);
	return services;
}

class WidgetTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return {
			identical: original.getValue() === modified.getValue(),
			quitEarly: result.hitTimeout,
			changes: result.changes,
			moves: result.moves,
		};
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

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());

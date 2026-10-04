import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Range } from '../../../common/core/range.js';
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
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
], { ResizeObserver: TestResizeObserver });
setIconResolver(browserEnvironment.window.document, icon => getIconDefinition(icon));

await import('../../../contrib/diffEditorBreadcrumbs/browser/contribution.js');
const { DiffEditorWidget } = await import('../../../browser/widget/diffEditor/diffEditorWidget.js');
const { DiffModel } = await import('../../../common/diff/diffModel.js');
const { registerCodeEditorServices } = await import('../testCodeEditor.js');
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

test('DiffEditorWidget colors inline removed lines and refreshes their tokens without replacing the accessible zone', async () => {
	using services = createServices();
	using providers = new SyntaxProviderRegistry();
	let tokenType = 'keyword';
	using registration = providers.register({
		id: 'test.diff-colors',
		languageIds: ['diff-colors'],
		provideTokens: () => ({ tokens: [{ range: new Range(1, 1, 1, 7), tokenType, modifiers: [] }] }),
	});
	using original = new TextModel('before', { languageId: 'diff-colors', tokenization: { syntaxProviderRegistry: providers } });
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
	assert.equal([...removedLine.querySelectorAll('.stanza-diff-inline-removed')].map(token => token.textContent).join(''), 'bfoe');

	tokenType = 'string';
	original.tokenization.resetTokenization();
	await original.tokenization.whenReady(new AbortController().signal);
	assert.strictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), removedLine);
	assert.equal(removedLine.querySelector('.token-keyword'), null);
	assert.equal([...removedLine.querySelectorAll('.token-string')].map(token => token.textContent).join(''), 'before');
});

test('inline removed lines follow semantic theme styles and coloring settings while retaining their difference marks', async () => {
	using services = createServices();
	using providers = new SyntaxProviderRegistry();
	using syntax = providers.register({ id: 'test.diff-theme', languageIds: ['diff-theme'], provideTokens: () => ({ tokens: [{ range: new Range(1, 1, 1, 7), tokenType: 'keyword', modifiers: [], presentation: { foreground: '#0000ff' } }] }) });
	const features = services.get(ILanguageFeaturesService);
	using semantic = features.documentSemanticTokensProvider.register('diff-theme', { provideSemanticTokens: () => ({ tokens: [{ range: new Range(1, 1, 1, 7), tokenType: 'variable', modifiers: [] }] }) });
	using original = new TextModel('before', { languageId: 'diff-theme', tokenization: { syntaxProviderRegistry: providers, documentSemanticTokensProvider: features.documentSemanticTokensProvider } });
	using modified = new TextModel('after');
	await original.tokenization.whenReady(new AbortController().signal);
	await original.tokenization.semanticTokens!.requestTokens('diff-theme');
	const themes = services.get(IThemeService) as TestThemeService;
	const theme = { ...darkColorTheme, semanticHighlighting: true, tokenColorMap: ['', '#ff0000'], getTokenStyleMetadata: () => ({ foreground: 1, bold: true }) };
	themes.setColorTheme(theme);
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	using editor = services.createInstance(DiffEditorWidget, { container: browserEnvironment.window.document.createElement('main'), model, renderSideBySide: false });
	editor.layout({ width: 400, height: 80 });
	const removedLine = editor.element.querySelector('.stanza-diff-inline-original-line')!;
	const style = () => {
		const token = removedLine.querySelector<HTMLElement>('.stanza-editor-token')!;
		return [token.style.getPropertyValue('--ash-editor-token-foreground'), token.style.fontWeight];
	};
	assert.deepEqual(style(), ['#ff0000', 'bold']);
	themes.setColorTheme({ ...theme, tokenColorMap: ['', '#00ff00'] });
	assert.strictEqual(editor.element.querySelector('.stanza-diff-inline-original-line'), removedLine);
	assert.deepEqual(style(), ['#00ff00', 'bold']);
	await services.get(IConfigurationService).updateValue('editor.semanticHighlighting.enabled', false);
	assert.deepEqual(style(), ['', '']);
	assert.equal([...removedLine.querySelectorAll('.stanza-diff-inline-removed')].map(token => token.textContent).join(''), 'bfoe');
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

test('DiffEditorWidget applies the split ratio and disables its separator when resizing is off', async () => {
	using services = createServices();
	using original = new TextModel('before');
	using modified = new TextModel('after');
	using computation = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computation, diffOptions });
	await waitForReady(model);
	const container = browserEnvironment.window.document.createElement('main');
	using editor = services.createInstance(DiffEditorWidget, {
		container, model, splitViewDefaultRatio: 0.3, enableSplitViewResizing: false,
	});
	editor.layout({ width: 530, height: 80 });
	assert.equal(editor.element.style.getPropertyValue('--stanza-diff-original-width'), '150px');
	const sash = editor.element.querySelector('.stanza-diff-sash');
	assert.equal(sash?.getAttribute('aria-disabled'), 'true');
	assert.equal(sash?.getAttribute('aria-valuenow'), '30');
	assert.equal((sash as HTMLElement).hidden, true);
	editor.setSplitViewOptions(true, 0.4);
	assert.equal(editor.element.style.getPropertyValue('--stanza-diff-original-width'), '200px');
	assert.equal(sash?.getAttribute('aria-disabled'), 'false');
	assert.throws(() => editor.setSplitViewOptions(true, 1), /between 0.1 and 0.9/);
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
		using editor = services.createInstance(DiffEditorWidget, { container: browserEnvironment.window.document.createElement('main'), model });
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
	using editor = services.createInstance(DiffEditorWidget, { container: browserEnvironment.window.document.createElement('main'), model });
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
	using editor = services.createInstance(DiffEditorWidget, { container: browserEnvironment.window.document.createElement('main'), model });
	const configuration = services.get(IConfigurationService);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 1);
	await configuration.updateValue('diffEditor.renderMarginRevertIcon', false);
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 0);
	editor.updateOptions({ renderMarginRevertIcon: true });
	assert.equal(editor.element.querySelectorAll('.ash-diff-revert').length, 1);
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

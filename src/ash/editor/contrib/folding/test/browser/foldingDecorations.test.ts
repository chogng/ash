import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import '../../../../test/browser/testEditorDom.js';
import { browserEnvironment as browser } from '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { registerTestTokens } from '../../../../test/common/testTokenization.js';
import { Range } from '../../../../common/core/range.js';

const { FoldingController } = await import('../../browser/folding.js');
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { FoldingDecorationProvider } = await import('../../browser/foldingDecorations.js');

test('tokenization batches coalesce whole-document folding provider requests', async () => {
	using features = new LanguageFeaturesService();
	let calls = 0;
	using registration = features.foldingRangeProvider.register('typescript', {
		provideFoldingRanges: () => {
			calls++;
			return [];
		},
	});
	using tokens = registerTestTokens(new Map());
	using model = new TextModel('function root() {\n  value\n}', { languageId: 'typescript' });
	using editor = createTestCodeEditor({
		container: document.createElement('main'),
		model,
		languageFeaturesService: features,
	});
	const initial = calls;
	assert.ok(initial > 0);
	let changes = 0;
	using changed = model.onDidChangeTokens(() => changes++);
	for (let index = 0; index < 32; index++) {
		model.tokenization.resetTokenization();
		model.tokenization.forceTokenization(model.getLineCount());
	}
	assert.ok(changes >= 32);
	assert.equal(calls, initial);
	await new Promise(resolve => setTimeout(resolve, 350));
	assert.equal(calls, initial + 1);
});

test('FoldingDecorationProvider selects controls, highlights, and editor-owned decoration lifetime', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('header\nbody\nend');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		lineHeight: 20,
		folding: false,
	});
	const provider = new FoldingDecorationProvider(editor);

	assert.match(
		provider.getDecorationOption(true, false, false).firstLineDecorationClassName ?? '',
		/folding-collapsed/,
	);
	assert.equal(provider.getDecorationOption(true, false, false).className, 'folded-background');
	provider.showFoldingHighlights = false;
	assert.equal(provider.getDecorationOption(true, false, false).className, undefined);
	provider.showFoldingControls = 'never';
	assert.equal(provider.getDecorationOption(true, false, false).firstLineDecorationClassName, undefined);
	assert.equal(provider.getDecorationOption(false, true, false).description, 'folding-hidden-range');

	let decorationId = '';
	provider.changeDecorations(accessor => {
		decorationId = accessor.addDecoration(
			model.getFullModelRange(),
			provider.getDecorationOption(true, false, true),
		);
	});
	assert.equal(model.getDecorationOptions(decorationId)?.description, 'folding-manually-collapsed');
	provider.removeDecorations([decorationId]);
	assert.equal(model.getDecorationRange(decorationId), null);
	dom.window.close();
});

test('Folding contribution projects model ranges through FoldingDecorationProvider', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('{\n  value\n}');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		lineHeight: 20,
	});
	editor.layout({ width: 320, height: 120 });
	editor.view.render(true, false);

	const initial = model.getAllDecorations().find(decoration => decoration.options.description === 'folding-expanded');
	assert.ok(initial);
	const expandedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-expanded');
	assert.equal(expandedMarker?.title, 'Collapse range');
	assert.equal(expandedMarker?.querySelectorAll('.ash-icon').length, 1);
	expandedMarker?.dispatchEvent(
		new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
	);
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-collapsed'));
	editor.view.render(true, false);
	const pointerCollapsedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-collapsed');
	pointerCollapsedMarker?.dispatchEvent(
		new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
	);
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-expanded'));
	await editor.getAction('editor.fold')!.run();
	editor.view.render(true, false);
	const collapsed = model
		.getAllDecorations()
		.find(decoration => decoration.options.description === 'folding-collapsed');
	assert.equal(collapsed?.options.afterContentClassName, 'inline-folded');
	const collapsedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-collapsed');
	assert.equal(collapsedMarker?.title, 'Expand folded range');
	assert.equal(collapsedMarker?.querySelectorAll('.ash-icon').length, 1);
	assert.strictEqual(FoldingController.get(editor)?.constructor, FoldingController);
	const saved = editor.saveViewState();
	assert.ok(saved);
	assert.deepEqual(
		(
			saved.contributionsState[FoldingController.ID] as {
				collapsedRegions: { startLineNumber: number; endLineNumber: number }[];
			}
		).collapsedRegions.map(range => [range.startLineNumber, range.endLineNumber]),
		[[1, 2]],
	);
	await editor.getAction('editor.unfold')!.run();
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-expanded'));
	editor.restoreViewState(saved);
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-collapsed'));
	dom.window.close();
});

test('fold headers stay on their physical line after Enter moves a tracked gutter decoration into the body', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('{\n  value\n}');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		lineHeight: 20,
	});
	editor.layout({ width: 320, height: 120 });
	editor.view.render(true, false);
	const firstHeader = () =>
		model.getAllDecorations().find(decoration => decoration.options.description === 'folding-expanded')?.range
			.startLineNumber;
	assert.equal(firstHeader(), 1);
	model.applyOperations([{ range: new Range(1, 2, 1, 2), text: '\n' }]);
	editor.view.render(true, false);
	assert.equal(firstHeader(), 1);
	assert.ok(
		editor.getDomNode().querySelector('.margin-view-overlays [data-line-index="0"] .ash-icon-folding-expanded'),
	);
	await model.undo();
	editor.view.render(true, false);
	assert.equal(firstHeader(), 1);
	dom.window.close();
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());

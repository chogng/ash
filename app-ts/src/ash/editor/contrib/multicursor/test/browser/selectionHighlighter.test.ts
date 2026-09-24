import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageFeaturesService } from '../../../../test/common/testLanguageFeaturesService.js';

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { TextualMultiDocumentHighlightFeature } = await import('../../../wordHighlighter/browser/textualHighlightProvider.js');
const { SelectionHighlighter } = await import('../../browser/multicursor.js');

test('Selection highlighter owns non-empty textual matches and excludes active selections', () => {
	using languages = new TestLanguageFeaturesService();
	using harness = createHarness('item itemized item\nitem', languages, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)));

	assert.deepEqual(harness.decorations.decorations.map(decoration => decoration.range), [
		Range.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (7) + 1)),
		Range.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (16) + 1)),
		Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (2) + 1)),
	]);
	assert.equal(harness.model.getAllDecorations().filter(decoration => decoration.options.className === 'selection-highlight').length, 3);
});

test('Selection highlighter applies whole-word, whitespace, multiline, and maximum-length policy', () => {
	using languages = new TestLanguageFeaturesService();
	using harness = createHarness('item itemized item\nitem', languages, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)));

	assert.deepEqual(harness.decorations.decorations.map(decoration => decoration.range), [
		Range.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (18) + 1)),
		Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (4) + 1)),
	]);
	harness.editor.setSelection(Selection.fromPositions(new Position((0) + 1, (4) + 1), new Position((0) + 1, (5) + 1)), 'test');
	assert.equal(harness.decorations.size, 0);
	harness.editor.setSelection(Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((1) + 1, (1) + 1)), 'test');
	assert.equal(harness.decorations.size, 0);
});

test('Selection highlighter exposes its canonical ID and clears listeners and decorations on dispose', () => {
	using languages = new TestLanguageFeaturesService();
	using harness = createHarness('item item item', languages, Selection.fromPositions(new Position(1, 1), new Position(1, 5)));
	assert.equal(SelectionHighlighter.ID, 'editor.contrib.selectionHighlighter');
	assert.equal(harness.decorations.size, 2);

	harness.controller.dispose();
	assert.equal(harness.decorations.size, 0);
	harness.editor.setSelection(Selection.fromPositions(new Position(1, 6), new Position(1, 10)), 'test');
	assert.equal(harness.decorations.size, 0);
});

function createHarness(text: string, languages: TestLanguageFeaturesService, initialSelection: Selection): SelectionHarness {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = new TextModel(text);
	const textualProvider = new TextualMultiDocumentHighlightFeature(languages);
	const decorations = new TextDecorationCollection<boolean>(model);
	const editor = createTestCodeEditor({
		container,
		model,
		contributions: [],
		lineHeight: 20,
	});
	editor.setSelection(initialSelection, 'test');
	const controller = new SelectionHighlighter(editor, decorations, {
		languageId: 'typescript',
		languageFeaturesService: languages,
	});
	editor.layout({ width: 240, height: 60 });
	return new SelectionHarness(dom, model, editor, decorations, controller, textualProvider);
}

class SelectionHarness implements Disposable {
	constructor(
		private readonly dom: JSDOM,
		readonly model: TextModel,
		readonly editor: InstanceType<typeof CodeEditorWidget>,
		readonly decorations: TextDecorationCollection<boolean>,
		readonly controller: InstanceType<typeof SelectionHighlighter>,
		private readonly textualProvider: InstanceType<typeof TextualMultiDocumentHighlightFeature>,
	) {}

	dispose(): void {
		this.textualProvider.dispose();
		this.controller.dispose();
		this.decorations.dispose();
		this.editor.dispose();
		this.model.dispose();
		this.dom.window.close();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	Event: environment.window.Event,
	InputEvent: environment.window.InputEvent,
	KeyboardEvent: environment.window.KeyboardEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { CursorUndoRedoController } = await import('../../browser/cursorUndo.js');

suiteTeardown(() => environment.window.close());

test('CursorUndoRedoController records canonical same-version selection events', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	const controller = CursorUndoRedoController.get(editor);
	assert.ok(controller);

	editor.setSelection(Selection.fromPositions(new Position(1, 3)), 'test.first');
	editor.setSelection(Selection.fromPositions(new Position(1, 5)), 'test.second');
	controller.cursorUndo();
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 3)));
	controller.cursorUndo();
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 1)));
	controller.cursorRedo();
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 3)));
	controller.cursorRedo();
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 5)));
	dom.window.close();
});

test('CursorUndoRedoController clears cursor history after document changes', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	const controller = CursorUndoRedoController.get(editor);
	assert.ok(controller);
	editor.setSelection(Selection.fromPositions(new Position(1, 3)), 'test.selection');
	model.applyEdits([{ range: Range.fromPositions(new Position(1, 1)), text: 'x' }]);
	const afterEdit = editor.getSelection();

	controller.cursorUndo();
	controller.cursorRedo();
	assert.deepEqual(editor.getSelection(), afterEdit);
	assert.equal(model.getText(), 'xalpha');
	dom.window.close();
});

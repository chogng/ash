import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { CursorUndoRedoController } = await import('../../browser/cursorUndo.js');


test('CursorUndoRedoController records canonical same-version selection events', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
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

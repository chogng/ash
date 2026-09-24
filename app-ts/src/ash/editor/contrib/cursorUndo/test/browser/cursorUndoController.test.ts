import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
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
const { EditorExtensionsRegistry } = await import('../../../../browser/editorExtensions.js');
const { CursorUndoRedoController } = await import('../../browser/cursorUndo.js');

suiteTeardown(() => environment.window.close());

test('CursorUndoRedoController restores and reapplies cursor-only history', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('one\ntwo');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	const original = [Selection.fromPositions(new Position(1, 1))];
	const multiple = [Selection.fromPositions(new Position(2, 1)), Selection.fromPositions(new Position(1, 1))];
	assert.ok(CursorUndoRedoController.get(editor));
	editor.setSelections(multiple);

	const undo = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'cursorUndo');
	assert.ok(undo);
	editor.invokeWithinContext(accessor => undo.run(accessor, editor, {}));
	assert.deepEqual(editor.getSelections(), original);

	const redo = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'cursorRedo');
	assert.ok(redo);
	editor.invokeWithinContext(accessor => redo.run(accessor, editor, {}));
	assert.deepEqual(editor.getSelections(), multiple);
	assert.equal(model.getText(), 'one\ntwo');
	dom.window.close();
});

import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: class TestResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { EditorExtensionsRegistry } = await import('../../../../browser/editorExtensions.js');
await import('../../../caretOperations/browser/transpose.js');
await import('../../../linesOperations/browser/linesOperations.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Transpose Letters runs directly through its canonical action', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('a😊b');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 2)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transposeLetters');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));

	assert.equal(model.getText(), '😊ab');
	assert.deepEqual(editor.selections.getSelections(), [Selection.fromPositions(new Position(1, 4))]);
	editor.selections.context.model.undo();
	assert.equal(model.getText(), 'a😊b');
	model.reset('ab\ncd');
	editor.setSelection(Selection.fromPositions(new Position(2, 1)));
	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), 'abc\nd');
	assert.deepEqual(editor.selections.getSelections(), [Selection.fromPositions(new Position(2, 1))]);
	editor.setSelection(Selection.fromPositions(new Position(1, 1), new Position(1, 2)));
	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), 'abc\nd');
	dom.window.close();
});

test('Transpose Action runs directly at a line end', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('hello\nworld');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 6)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transpose');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));

	assert.equal(model.getText(), 'hell\noworld');
	assert.deepEqual(editor.selections.getSelections(), [Selection.fromPositions(new Position(2, 2))]);
	dom.window.close();
});

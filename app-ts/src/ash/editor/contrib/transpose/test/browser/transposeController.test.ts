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
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 2)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transposeLetters');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));

	assert.equal(model.getText(), '😊ab');
	assert.deepEqual(editor.getSelections()!, [Selection.fromPositions(new Position(1, 4))]);
	editor.getModel()!.undo();
	assert.equal(model.getText(), 'a😊b');
	model.reset('ab\ncd');
	editor.setSelection(Selection.fromPositions(new Position(2, 1)));
	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), 'abc\nd');
	assert.deepEqual(editor.getSelections()!, [Selection.fromPositions(new Position(2, 1))]);
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
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 6)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transpose');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));

	assert.equal(model.getText(), 'hell\noworld');
	assert.deepEqual(editor.getSelections()!, [Selection.fromPositions(new Position(2, 2))]);
	dom.window.close();
});

for (const primary of [new Selection(1, 3, 1, 1), new Selection(1, 1, 1, 1)]) {
	test(`Transpose Letters preserves an inactive primary selection ${primary.toString()}`, () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		try {
			using model = new TextModel('keep\na😊b');
			using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
			const initial = [primary, new Selection(2, 2, 2, 2)];
			editor.setSelections(initial);
			const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transposeLetters');
			assert.ok(action);
			editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
			assert.deepEqual({ value: model.getValue(), selections: editor.getSelections() }, {
				value: 'keep\n😊ab', selections: [primary, new Selection(2, 4, 2, 4)],
			});
			model.undo();
			assert.deepEqual({ value: model.getValue(), selections: editor.getSelections() }, { value: 'keep\na😊b', selections: initial });
			model.redo();
			assert.deepEqual(editor.getSelections(), [primary, new Selection(2, 4, 2, 4)]);
		} finally {
			dom.window.close();
		}
	});
}

test('Transpose Letters leaves a single emoji unchanged without publishing an edit', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	try {
		using model = new TextModel('😊');
		using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
		const selection = new Selection(1, 3, 1, 3);
		editor.setSelection(selection);
		const version = model.getVersionId();
		const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.transposeLetters');
		assert.ok(action);
		editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
		assert.deepEqual({ value: model.getValue(), version: model.getVersionId(), selections: editor.getSelections() }, { value: '😊', version, selections: [selection] });
	} finally {
		dom.window.close();
	}
});

import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';

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
const { EditorExtensionsRegistry } = await import('../../../../browser/editorExtensions.js');
await import('../../browser/comment.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Toggle Line Comment runs through the canonical editor action', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('  alpha\nbeta', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register('typescript', { comments: { lineComment: '//' } });
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		languageConfigurationService: configurations,
		lineHeight: 20,
	});
	editor.setSelection(Selection.fromPositions(new Position(1, 1), new Position(2, 5)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.commentLine');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), '//   alpha\n// beta');
	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), '  alpha\nbeta');
	dom.window.close();
});

test('Toggle Line Comment leaves languages without a line comment token unchanged', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha', { languageId: 'plaintext' });
	using configurations = new TestLanguageConfigurationService();
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		languageConfigurationService: configurations,
		lineHeight: 20,
	});
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(candidate => candidate.id === 'editor.action.commentLine');
	assert.ok(action);

	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.equal(model.getText(), 'alpha');
	dom.window.close();
});

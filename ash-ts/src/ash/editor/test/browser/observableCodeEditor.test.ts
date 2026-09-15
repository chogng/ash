import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { autorun, observableValue } from '../../../base/common/observable.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { Selection } from '../../common/core/selection.js';
import { TextModel } from '../../common/model/textModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { observableCodeEditor } = await import('../../browser/observableCodeEditor.js');
const { CodeEditorWidget } = await import('../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('./testCodeEditor.js');

suiteTeardown(() => browserEnvironment.window.close());

test('observable code editor tracks canonical model, selections, and layout', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	using observableEditor = observableCodeEditor(editor);

	assert.strictEqual(observableCodeEditor(editor), observableEditor);
	assert.equal(observableEditor.value.get(), 'alpha');
	assert.equal(observableEditor.cursorLineNumber.get(), 1);

	const observedValues: string[] = [];
	using reaction = autorun(reader => {
		observedValues.push(`${observableEditor.versionId.read(reader)}:${observableEditor.value.read(reader)}`);
	});

	model.reset('beta');
	assert.equal(observableEditor.value.get(), 'beta');
	assert.equal(observableEditor.valueIsEmpty.get(), false);

	editor.setSelection(Selection.fromPositions(new Position((0) + 1, (2) + 1)));
	assert.equal(observableEditor.cursorPosition.get()?.column, 3);

	observableEditor.value.set('');
	assert.equal(model.getText(), '');
	assert.equal(observableEditor.valueIsEmpty.get(), true);
	assert.equal(observedValues.at(-1)?.endsWith(':'), true);

	editor.layout({ width: 320, height: 80 });
	assert.equal(observableEditor.layoutInfoWidth.get(), 320);
	assert.equal(observableEditor.layoutInfoHeight.get(), 80);
	assert.equal(observableEditor.domNode.get(), editor.getDomNode());

	dom.window.close();
});

test('observable code editor line APIs use one-based line numbers', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha\nbeta');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	using observableEditor = observableCodeEditor(editor);
	editor.layout({ width: 320, height: 80 });

	assert.equal(observableEditor.observeLineHeightForLine(1).get(), 20);
	assert.equal(observableEditor.observeLineHeightForLine(2).get(), 20);
	assert.ok(observableEditor.observeTopForLineNumber(1).get() < observableEditor.observeTopForLineNumber(2).get());
	assert.ok(observableEditor.observeBottomForLineNumber(1).get() <= observableEditor.observeTopForLineNumber(2).get());
	assert.doesNotThrow(() => observableEditor.getWidthOfLine(1));
	assert.throws(() => observableEditor.getWidthOfLine(0), /Line number/);

	dom.window.close();
});

test('observable code editor owns reactive decorations and follows editor disposal', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha');
	const editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	const observableEditor = observableCodeEditor(editor);
	const source = observableValue('decorations', [{ range: new Range(1, 1, 1, 3), options: { description: 'observable' } }]);
	using decorationOwner = observableEditor.setDecorations(source);

	assert.deepEqual(model.getAllDecorations().map(decoration => decoration.range), [new Range(1, 1, 1, 3)]);
	source.set([]);
	assert.equal(model.getAllDecorations().length, 0);

	editor.dispose();
	assert.equal(observableEditor.isDisposed, true);
	dom.window.close();
});

test('observable code editor follows model attachment changes without retaining old listeners', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using first = new TextModel('first');
	using second = new TextModel('second');
	using editor = createTestCodeEditor({ container, model: first, input: { resource: first.uri }, languageId: first.getLanguageId(), lineHeight: 20 });
	using observableEditor = observableCodeEditor(editor);
	const values: string[] = [];
	using reaction = autorun(reader => {
		values.push(`${observableEditor.model.read(reader)?.uri.toString() ?? 'none'}:${observableEditor.value.read(reader)}`);
	});

	editor.setModel(second);
	assert.strictEqual(observableEditor.model.get(), second);
	assert.equal(observableEditor.value.get(), 'second');
	first.setValue('stale');
	assert.equal(values.at(-1), `${second.uri}:second`);
	second.setValue('current');
	assert.equal(values.at(-1), `${second.uri}:current`);

	editor.setModel(null);
	assert.deepEqual({ model: observableEditor.model.get(), value: observableEditor.value.get(), selection: observableEditor.cursorSelection.get() }, { model: null, value: '', selection: null });
	editor.setModel(first);
	assert.strictEqual(observableEditor.model.get(), first);
	assert.equal(observableEditor.value.get(), 'stale');
	dom.window.close();
});

test('observable decorations follow the attached model and release old ranges', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using first = new TextModel('first');
	using second = new TextModel('second');
	using editor = createTestCodeEditor({ container, model: first, input: { resource: first.uri }, languageId: first.getLanguageId(), lineHeight: 20 });
	using observableEditor = observableCodeEditor(editor);
	const source = observableValue('switch-decorations', [{ range: new Range(1, 1, 1, 2), options: { description: 'switch' } }]);
	using owner = observableEditor.setDecorations(source);
	assert.equal(first.getAllDecorations().length, 1);

	editor.setModel(second);
	assert.equal(first.getAllDecorations().length, 0);
	assert.equal(second.getAllDecorations().length, 1);
	source.set([{ range: new Range(1, 2, 1, 3), options: { description: 'moved' } }]);
	assert.deepEqual(second.getAllDecorations().map(decoration => decoration.range), [new Range(1, 2, 1, 3)]);
	editor.setModel(null);
	assert.equal(second.getAllDecorations().length, 0);
	editor.setModel(first);
	assert.deepEqual(first.getAllDecorations().map(decoration => decoration.range), [new Range(1, 2, 1, 3)]);
	dom.window.close();
});

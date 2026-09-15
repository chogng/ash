import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

installDom(new JSDOM('<!doctype html><body></body>'));
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
await import('../../browser/linesOperations.js');

test('selected-line Tab remains available to the host keybinding', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('one\n  two\nthree', { tabSize: 2, indentSize: 2, insertSpaces: true });
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 1), new Position(3, 6)));

	const indent = key(dom.window, 'Tab');
	editor.controller.element.dispatchEvent(indent);
	assert.equal(indent.defaultPrevented, false);
	assert.equal(model.getText(), 'one\n  two\nthree');
	const outdent = key(dom.window, 'Tab', { shiftKey: true });
	editor.controller.element.dispatchEvent(outdent);
	assert.equal(outdent.defaultPrevented, false);
	assert.equal(model.getText(), 'one\n  two\nthree');
	dom.window.close();
});

function key(target: JSDOM['window'], value: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new target.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, ...options }) as unknown as KeyboardEvent;
}

function installDom(dom: JSDOM): void {
	for (const [name, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		InputEvent: dom.window.InputEvent,
		KeyboardEvent: dom.window.KeyboardEvent,
		ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
	})) Object.defineProperty(globalThis, name, { configurable: true, value });
}

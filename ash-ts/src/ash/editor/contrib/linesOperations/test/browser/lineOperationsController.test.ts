import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { EditorExtensionsRegistry } from '../../../../browser/editorExtensions.js';

installDom(new JSDOM('<!doctype html><body></body>'));
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
await import('../../browser/linesOperations.js');

test('line actions are registered while the host owns their shortcuts', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('zero\none\ntwo');
	using editor = new CodeEditorWidget({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(2, 2)));

	const actionIds = new Set(Array.from(EditorExtensionsRegistry.getEditorActions(), action => action.id));
	for (const id of [
		'editor.action.copyLinesDownAction',
		'editor.action.moveLinesDownAction',
		'editor.action.deleteLines',
		'editor.action.insertLineAfter',
	]) {
		assert.ok(actionIds.has(id), id + ' should be registered');
	}
	for (const event of [
		key(dom.window, 'ArrowDown', { altKey: true, shiftKey: true }),
		key(dom.window, 'ArrowDown', { altKey: true }),
		key(dom.window, 'k', { ctrlKey: true, shiftKey: true }),
		key(dom.window, 'Enter', { ctrlKey: true }),
	]) {
		editor.view.element.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
		assert.equal(model.getText(), 'zero\none\ntwo');
	}
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

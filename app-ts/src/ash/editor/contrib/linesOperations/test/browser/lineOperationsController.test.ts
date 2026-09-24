import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { EditorExtensionsRegistry } from '../../../../browser/editorExtensions.js';
import { installEditorTestDom } from '../../../../test/browser/editorTestGlobals.js';

const moduleDom = new JSDOM('<!doctype html><body></body>');
const installedGlobals = installEditorTestDom(moduleDom, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
], {
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
});
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
await import('../../browser/linesOperations.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	moduleDom.window.close();
});

test('line actions are registered while the host owns their shortcuts', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('zero\none\ntwo');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
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
		editor.controller.element.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
		assert.equal(model.getText(), 'zero\none\ntwo');
	}
	dom.window.close();
});

function key(target: JSDOM['window'], value: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new target.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, ...options }) as unknown as KeyboardEvent;
}

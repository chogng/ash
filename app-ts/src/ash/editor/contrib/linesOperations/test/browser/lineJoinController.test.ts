import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { operatingSystem, OperatingSystem } from '../../../../../base/common/platform.js';
import { installEditorTestDom } from '../../../../test/browser/editorTestGlobals.js';

const moduleDom = new JSDOM('<!doctype html><body></body>');
const installedGlobals = installEditorTestDom(moduleDom, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
], {
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
});
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { JoinLinesAction } = await import('../../browser/linesOperations.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	moduleDom.window.close();
});

test('the host owns the join shortcut and the registered action joins lines', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('first\n  second');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 3)));
	const event = new dom.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		key: 'j',
		...(operatingSystem === OperatingSystem.Macintosh ? { metaKey: true } : { ctrlKey: true }),
	});
	editor.controller.element.dispatchEvent(event);
	assert.equal(event.defaultPrevented, false);
	assert.equal(model.getText(), 'first\n  second');
	new JoinLinesAction().run({} as never, editor);
	assert.equal(model.getText(), 'first second');
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 6)));
	dom.window.close();
});

import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { TextModel } from '../../../../common/model/textModel.js';
import '../../browser/middleScroll.contribution.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	HTMLCanvasElement: environment.window.HTMLCanvasElement,
	Event: environment.window.Event,
	KeyboardEvent: environment.window.KeyboardEvent,
	PointerEvent: environment.window.PointerEvent ?? environment.window.MouseEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });
environment.window.HTMLCanvasElement.prototype.getContext = () => null;

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { MiddleScrollController } = await import('../../browser/middleScrollController.js');

suiteTeardown(() => environment.window.close());

test('middle click opens a scroll session and keyboard input closes it', () => {
	const container = environment.window.document.createElement('main');
	environment.window.document.body.append(container);
	using model = new TextModel('one\ntwo\nthree');
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		scrollOnMiddleClick: true,
	});
	editor.layout({ width: 300, height: 60 });
	editor.focus();
	const pointer = new environment.window.Event('pointerdown', { bubbles: true, cancelable: true });
	Object.defineProperties(pointer, {
		button: { value: 1 },
		pointerId: { value: 4 },
		clientX: { value: 40 },
		clientY: { value: 30 },
	});
	editor.viewport.domNode.domNode.dispatchEvent(pointer);

	assert.ok(MiddleScrollController.get(editor));
	assert.equal(pointer.defaultPrevented, true);
	assert.equal(editor.viewport.domNode.domNode.classList.contains('scroll-editor-on-middle-click-editor'), true);
	const dot = editor.viewport.domNode.domNode.querySelector('.scroll-editor-on-middle-click-dot');
	assert.ok(dot);
	assert.equal(dot.getAttribute('aria-hidden'), 'true');
	editor.view.element.dispatchEvent(new environment.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
	assert.equal(editor.viewport.domNode.domNode.classList.contains('scroll-editor-on-middle-click-editor'), false);
	assert.equal(editor.viewport.domNode.domNode.querySelector('.scroll-editor-on-middle-click-dot'), null);
	container.remove();
});

test('disabled middle-click scrolling does not create a scroll session', () => {
	const container = environment.window.document.createElement('main');
	using model = new TextModel('one\ntwo\nthree');
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		scrollOnMiddleClick: false,
	});
	editor.layout({ width: 300, height: 60 });
	const pointer = pointerEvent('pointerdown', 1, 5, 40, 30);
	editor.viewport.domNode.domNode.dispatchEvent(pointer);

	assert.ok(MiddleScrollController.get(editor));
	assert.equal(editor.viewport.domNode.domNode.classList.contains('scroll-editor-on-middle-click-editor'), false);
	assert.equal(editor.viewport.domNode.domNode.querySelector('.scroll-editor-on-middle-click-dot'), null);
});

test('pointer displacement continuously scrolls and release ends an active movement', async () => {
	const container = environment.window.document.createElement('main');
	using model = new TextModel(Array.from({ length: 80 }, (_, index) => `${'line content '.repeat(20)}${index}`).join('\n'));
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		scrollOnMiddleClick: true,
	});
	editor.layout({ width: 300, height: 60 });
	editor.viewport.domNode.domNode.dispatchEvent(pointerEvent('pointerdown', 1, 7, 40, 30));
	environment.window.dispatchEvent(pointerEvent('pointermove', 0, 7, 120, 100));
	await new Promise(resolve => setTimeout(resolve, 50));
	environment.window.dispatchEvent(pointerEvent('pointerup', 0, 7, 120, 100));

	assert.ok(editor.viewport.currentLayout.scrollPosition.top > 0);
	assert.ok(editor.viewport.currentLayout.scrollPosition.left > 0);
	assert.equal(editor.viewport.domNode.domNode.classList.contains('scroll-editor-on-middle-click-editor'), false);
});

function pointerEvent(type: string, button: number, pointerId: number, clientX: number, clientY: number): Event {
	const event = new environment.window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		button: { value: button },
		pointerId: { value: pointerId },
		clientX: { value: clientX },
		clientY: { value: clientY },
	});
	return event;
}

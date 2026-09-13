import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ClientCoordinates, DynamicCssRules, EditorDom, EditorMouseEventFactory, GlobalEditorPointerMoveMonitor, PageCoordinates, createCoordinatesRelativeToEditor, createEditorPagePosition } from '../../browser/editorDom.js';
import { type ICodeEditor } from '../../browser/editorBrowser.js';

test('EditorDom owns stable roots, layout writes, and attachment lifecycle', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(parent);
	const editorDom = new EditorDom({
		rootClassName: 'editor-root',
		contentClassName: 'editor-content',
	});
	editorDom.attach(parent);
	editorDom.layout({ width: -10, height: 240 });

	assert.equal(parent.firstElementChild, editorDom.domNode);
	assert.equal(editorDom.domNode.className, 'editor-root');
	assert.equal(editorDom.contentDomNode.className, 'editor-content');
	assert.equal(editorDom.domNode.style.width, '0px');
	assert.equal(editorDom.domNode.style.height, '240px');
	assert.equal(editorDom.contentDomNode.style.width, '0px');
	assert.equal(editorDom.contentDomNode.style.height, '240px');
	assert.throws(() => editorDom.attach(parent), ReferenceError);

	editorDom.dispose();
	assert.equal(parent.contains(editorDom.domNode), false);
	dom.window.close();
});

test('DynamicCssRules tolerates references released after their owner', () => {
	const dom = new JSDOM('<!doctype html><head></head><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(container);
	const rules = new DynamicCssRules({ getContainerDomNode: () => container } as ICodeEditor);
	const reference = rules.createClassNameRef({ backgroundColor: '#ff0000' });
	assert.match(reference.className, /^dyn-rule-/u);
	assert.match(dom.window.document.head.textContent ?? '', /background-color:\s*#ff0000/u);

	rules.dispose();
	assert.doesNotThrow(() => reference.dispose());
	assert.throws(() => rules.createClassNameRef({ color: '#ffffff' }), /already disposed/);
	dom.window.close();
});

test('editor coordinate contracts preserve page/client identity and undo element scale', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editor = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editor);
	Object.defineProperties(dom.window, {
		scrollX: { configurable: true, value: 30 },
		scrollY: { configurable: true, value: 40 },
	});
	Object.defineProperties(editor, {
		offsetWidth: { configurable: true, value: 200 },
		offsetHeight: { configurable: true, value: 100 },
	});
	editor.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 220, width: 400, height: 200, toJSON: () => ({}) });

	const page = new ClientCoordinates(20, 35).toPageCoordinates(dom.window as unknown as Window);
	assert.deepEqual(page, new PageCoordinates(50, 75));
	assert.deepEqual(page.toClientCoordinates(dom.window as unknown as Window), new ClientCoordinates(20, 35));
	const editorPosition = createEditorPagePosition(editor);
	assert.deepEqual({ ...editorPosition }, { x: 40, y: 60, width: 400, height: 200 });
	assert.deepEqual({ ...createCoordinatesRelativeToEditor(editor, editorPosition, new PageCoordinates(240, 160)) }, { x: 100, y: 50 });

	dom.window.close();
});

test('editor relative coordinates remain finite before layout dimensions are available', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editor = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editor);
	editor.getBoundingClientRect = () => ({ x: 5, y: 7, left: 5, top: 7, right: 5, bottom: 7, width: 0, height: 0, toJSON: () => ({}) });
	const editorPosition = createEditorPagePosition(editor);
	assert.deepEqual({ ...createCoordinatesRelativeToEditor(editor, editorPosition, new PageCoordinates(15, 27)) }, { x: 10, y: 20 });
	dom.window.close();
});

test('EditorMouseEventFactory listeners stop publishing after disposal', () => {
	const dom = new JSDOM('<!doctype html><body><main><button></button></main></body>');
	const editor = dom.window.document.querySelector<HTMLElement>('main');
	const button = dom.window.document.querySelector<HTMLElement>('button');
	assert.ok(editor && button);
	const events = new EditorMouseEventFactory(editor);
	const positions: Array<{ readonly x: number; readonly y: number }> = [];
	const listener = events.onMouseDown(editor, event => positions.push({ x: event.relativePos.x, y: event.relativePos.y }));
	button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, clientX: 12, clientY: 18 }));
	listener.dispose();
	button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, clientX: 30, clientY: 40 }));
	assert.deepEqual(positions, [{ x: 12, y: 18 }]);
	dom.window.close();
});

test('GlobalEditorPointerMoveMonitor replaces sessions and stops on pointer release', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editor = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editor);
	const monitor = new GlobalEditorPointerMoveMonitor(editor);
	const moves: number[] = [];
	const stops: string[] = [];
	monitor.startMonitoring(editor, 7, 1, event => moves.push(event.clientX), event => stops.push(event?.type ?? 'manual'));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 7, 1, 14));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 8, 1, 20));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointerup', 7, 0, 14));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 7, 1, 30));
	assert.deepEqual({ moves, stops }, { moves: [14], stops: ['pointerup'] });
	monitor.dispose();
	dom.window.close();
});

test('GlobalEditorPointerMoveMonitor cancels a pointer session on a non-modifier key', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editor = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editor);
	const monitor = new GlobalEditorPointerMoveMonitor(editor);
	const moves: number[] = [];
	const stops: string[] = [];
	monitor.startMonitoring(editor, 9, 1, event => moves.push(event.clientX), event => stops.push(event?.type ?? 'manual'));
	editor.ownerDocument.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 9, 1, 40));
	assert.deepEqual({ moves, stops }, { moves: [], stops: ['keydown'] });
	monitor.dispose();
	dom.window.close();
});

function pointerEvent(dom: JSDOM, type: string, pointerId: number, buttons: number, clientX: number): Event {
	const event = new dom.window.MouseEvent(type, { buttons, clientX }) as unknown as Event & { pointerId: number };
	Object.defineProperty(event, 'pointerId', { configurable: true, value: pointerId });
	return event;
}

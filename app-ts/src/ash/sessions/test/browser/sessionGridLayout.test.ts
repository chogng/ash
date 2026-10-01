import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { SessionGridLayout } from '../../browser/parts/sessionGridLayout.js';

class TestView implements IView {
	public readonly element: HTMLDivElement;
	public readonly minimumWidth = 100;
	public readonly maximumWidth = Number.POSITIVE_INFINITY;
	public readonly minimumHeight = 0;
	public readonly maximumHeight = Number.POSITIVE_INFINITY;
	public bounds: IPositionedRectangle | undefined;

	constructor(document: Document) {
		this.element = document.createElement('div');
		this.element.append(document.createElement('input'));
	}

	public layout(bounds: IPositionedRectangle): void {
		this.bounds = bounds;
	}
}

test('Sessions split insertion preserves an unrelated pane and retained input focus', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	const third = new TestView(document);
	try {
		using layout = new SessionGridLayout(document.body, first);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		layout.layout(1_200, 800);
		const firstBounds = first.bounds;
		first.element.querySelector('input')!.focus();
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'first');
		layout.layout(1_200, 800);
		assert.deepEqual({ bounds: first.bounds, focused: document.activeElement }, { bounds: firstBounds, focused: first.element.querySelector('input') });
		const beforeMaterialization = [first.bounds, second.bounds, third.bounds];
		layout.reconcile([{ id: 'durable-first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'durable-first');
		assert.deepEqual([first.bounds, second.bounds, third.bounds], beforeMaterialization);
	} finally {
		browser.window.close();
	}
});

test('Sessions rearrangement keeps live inputs and does not steal focus from another region', () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	try {
		using layout = new SessionGridLayout(document.body, first);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		layout.layout(1_200, 800);
		first.element.querySelector('input')!.value = 'Unsent text';
		const sidebar = document.querySelector('button')!;
		sidebar.focus();
		layout.reconcile([{ id: 'second', view: second }, { id: 'first', view: first }], 'first');
		assert.deepEqual({ focused: document.activeElement, input: first.element.querySelector('input')!.value }, { focused: sidebar, input: 'Unsent text' });
		layout.reconcile([{ id: 'first', view: first }], 'first');
		assert.equal(second.element.isConnected, false);
		assert.equal(first.element.isConnected, true);
	} finally {
		browser.window.close();
	}
});

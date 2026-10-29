import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IPositionedRectangle } from '../../browser/geometry.js';
import { h } from '../../browser/dom.js';
import type { IBoundarySashes } from '../../browser/ui/sash/sash.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	PointerEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { GridView } = await import('../../browser/ui/grid/gridview.js');

test('GridView delivers physical boundary sashes through nested axes and clears detached leaves', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		class BoundaryView extends TestView {
			boundaries: IBoundarySashes = {};
			setBoundarySashes(sashes: IBoundarySashes): void {
				this.boundaries = sashes;
			}
		}
		const topLeft = new BoundaryView(dom.window.document, 'topLeft');
		const bottomLeft = new BoundaryView(dom.window.document, 'bottomLeft');
		const topRight = new BoundaryView(dom.window.document, 'topRight');
		const bottomRight = new BoundaryView(dom.window.document, 'bottomRight');
		using grid = new GridView(dom.window.document.body, {
			type: 'branch',
			orientation: 'horizontal',
			size: 800,
			children: [
				[topLeft, bottomLeft],
				[topRight, bottomRight],
			].map(views => ({
				type: 'branch',
				orientation: 'vertical',
				size: 400,
				children: views.map(view => ({ type: 'leaf', view, size: 200 })),
			})),
		});
		grid.layout(800, 400);
		assert.ok(topLeft.boundaries.right);
		assert.equal(topLeft.boundaries.right, topRight.boundaries.left);
		assert.equal(topLeft.boundaries.right, bottomLeft.boundaries.right);
		assert.equal(topLeft.boundaries.right.orientation, 'vertical');
		assert.ok(topLeft.boundaries.bottom);
		assert.equal(topLeft.boundaries.bottom, bottomLeft.boundaries.top);
		assert.equal(topLeft.boundaries.bottom.orientation, 'horizontal');
		assert.equal(topLeft.boundaries.left, undefined);
		assert.equal(topLeft.boundaries.top, undefined);
		assert.equal(bottomRight.boundaries.right, undefined);
		assert.equal(bottomRight.boundaries.bottom, undefined);
		grid.removeView([0, 0]);
		assert.deepEqual(topLeft.boundaries, {});
		assert.equal(bottomLeft.boundaries.top, undefined);
		assert.equal(bottomLeft.boundaries.right, topRight.boundaries.left);
		grid.dispose();
		for (const view of [topLeft, bottomLeft, topRight, bottomRight]) {
			assert.deepEqual(view.boundaries, {});
		}
	} finally {
		dom.window.close();
	}
});

test('GridView sash updates lay out only leaves whose geometry changes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const sidebar = new TestView(dom.window.document, 'sidebar', 100);
		const editor = new TestView(dom.window.document, 'editor', 100);
		const chat = new TestView(dom.window.document, 'chat', 100);
		using grid = new GridView(dom.window.document.body, {
			type: 'branch',
			orientation: 'horizontal',
			size: 800,
			children: [
				{ type: 'leaf', view: sidebar, size: 200 },
				{ type: 'leaf', view: editor, size: 400 },
				{ type: 'leaf', view: chat, size: 200 },
			],
		});
		grid.layout(800, 400);
		const initialLayouts = [sidebar, editor, chat].map(view => view.layouts.length);
		const sash = grid.element.querySelectorAll<HTMLElement>('.ash-sash')[1]!;
		sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 600 }));
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 640 }));
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 640 }));
		assert.deepEqual(
			[sidebar, editor, chat].map((view, index) => view.layouts.length - initialLayouts[index]!),
			[0, 1, 1],
		);
		assert.deepEqual(editor.layouts.at(-1), { width: 440, height: 400, top: 0, left: 200 });
		assert.deepEqual(chat.layouts.at(-1), { width: 160, height: 400, top: 0, left: 640 });
		Object.defineProperty(editor, 'minimumWidth', { value: 110 });
		sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 640 }));
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 640 }));
		dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 640 }));
		assert.deepEqual(
			[sidebar, editor, chat].map((view, index) => view.layouts.length - initialLayouts[index]!),
			[0, 2, 1],
		);
		// Explicit refresh must still reach content whose inset or constraints changed.
		grid.layout(800, 400);
		assert.deepEqual(
			[sidebar, editor, chat].map((view, index) => view.layouts.length - initialLayouts[index]!),
			[1, 3, 2],
		);
	} finally {
		dom.window.close();
	}
});

class TestView {
	readonly element: HTMLDivElement;
	readonly layouts: IPositionedRectangle[] = [];

	constructor(
		ownerDocument: Document,
		readonly id: string,
		readonly minimumWidth = 0,
		readonly maximumWidth = Number.POSITIVE_INFINITY,
		readonly minimumHeight = 0,
		readonly maximumHeight = Number.POSITIVE_INFINITY,
	) {
		this.element = h(ownerDocument, 'div');
		this.element.dataset.viewId = id;
	}

	layout(bounds: IPositionedRectangle): void {
		this.layouts.push(bounds);
	}
}

test('GridView adds and removes leaves by GridLocation', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const left = new TestView(dom.window.document, 'left', 100);
	const editor = new TestView(dom.window.document, 'editor', 100);
	const panel = new TestView(dom.window.document, 'panel', 100);
	const gridview = new GridView(dom.window.document.body, {
		type: 'branch',
		orientation: 'horizontal',
		size: 600,
		children: [
			{ type: 'leaf', view: left, size: 200 },
			{ type: 'leaf', view: editor, size: 400 },
		],
	});
	gridview.layout(600, 400);

	gridview.addView(panel, { type: 'split', index: 1 }, [1, 1]);

	assert.deepEqual(gridview.getViewLocation(editor), [1, 0]);
	assert.deepEqual(gridview.getViewLocation(panel), [1, 1]);
	assert.deepEqual(gridview.getViewSize([1, 0]), { width: 400, height: 200 });
	assert.deepEqual(gridview.getViewSize([1, 1]), { width: 400, height: 200 });

	assert.equal(gridview.removeView([1, 1]), panel);
	assert.deepEqual(gridview.getViewLocation(editor), [1]);
	assert.deepEqual(gridview.getViewSize([1]), { width: 400, height: 400 });
	assert.equal(panel.element.parentElement, null);

	gridview.dispose();
	dom.window.close();
});

test('GridView moves siblings while preserving their sizes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const left = new TestView(dom.window.document, 'left');
	const editor = new TestView(dom.window.document, 'editor');
	const gridview = new GridView(dom.window.document.body, {
		type: 'branch',
		orientation: 'horizontal',
		size: 600,
		children: [
			{ type: 'leaf', view: left, size: 200 },
			{ type: 'leaf', view: editor, size: 400 },
		],
	});
	gridview.layout(600, 400);

	gridview.moveView([], 0, 1);

	assert.deepEqual(gridview.getViewLocation(editor), [0]);
	assert.deepEqual(gridview.getViewLocation(left), [1]);
	assert.deepEqual(gridview.getViewSize([0]), { width: 400, height: 400 });
	assert.deepEqual(gridview.getViewSize([1]), { width: 200, height: 400 });

	gridview.dispose();
	dom.window.close();
});

test('GridView removes an empty nested branch', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const nested = new TestView(dom.window.document, 'nested');
	const editor = new TestView(dom.window.document, 'editor');
	const gridview = new GridView(dom.window.document.body, {
		type: 'branch',
		orientation: 'horizontal',
		size: 600,
		children: [
			{
				type: 'branch',
				orientation: 'vertical',
				size: 200,
				children: [{ type: 'leaf', view: nested, size: 400 }],
			},
			{ type: 'leaf', view: editor, size: 400 },
		],
	});
	gridview.layout(600, 400);

	gridview.removeView([0, 0]);

	assert.deepEqual(gridview.getViewLocation(editor), [0]);
	assert.deepEqual(gridview.getViewSize([0]), { width: 600, height: 400 });

	gridview.dispose();
	dom.window.close();
});

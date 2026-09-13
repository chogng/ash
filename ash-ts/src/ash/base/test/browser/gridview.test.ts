import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IPositionedRectangle } from "../../browser/geometry.js";
import { h } from "../../browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
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
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { GridView } = await import("../../browser/ui/grid/gridview.js");

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
		this.element = h(ownerDocument, "div");
		this.element.dataset.viewId = id;
	}

	layout(bounds: IPositionedRectangle): void {
		this.layouts.push(bounds);
	}
}

test("GridView adds and removes leaves by GridLocation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestView(dom.window.document, "left", 100);
	const editor = new TestView(dom.window.document, "editor", 100);
	const panel = new TestView(dom.window.document, "panel", 100);
	const gridview = new GridView(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: editor, size: 400 },
		],
	});
	gridview.layout(600, 400);

	gridview.addView(panel, { type: "split", index: 1 }, [1, 1]);

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

test("GridView moves siblings while preserving their sizes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestView(dom.window.document, "left");
	const editor = new TestView(dom.window.document, "editor");
	const gridview = new GridView(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: editor, size: 400 },
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

test("GridView removes an empty nested branch", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const nested = new TestView(dom.window.document, "nested");
	const editor = new TestView(dom.window.document, "editor");
	const gridview = new GridView(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{
				type: "branch",
				orientation: "vertical",
				size: 200,
				children: [
					{ type: "leaf", view: nested, size: 400 },
				],
			},
			{ type: "leaf", view: editor, size: 400 },
		],
	});
	gridview.layout(600, 400);

	gridview.removeView([0, 0]);

	assert.deepEqual(gridview.getViewLocation(editor), [0]);
	assert.deepEqual(gridview.getViewSize([0]), { width: 600, height: 400 });

	gridview.dispose();
	dom.window.close();
});

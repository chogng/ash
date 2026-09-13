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

const { Direction, Grid, SerializableGrid, Sizing } = await import(
	"../../browser/ui/grid/grid.js"
);

class TestView {
	readonly element: HTMLDivElement;

	constructor(
		ownerDocument: Document,
		readonly minimumWidth = 0,
		readonly maximumWidth = Number.POSITIVE_INFINITY,
		readonly minimumHeight = 0,
		readonly maximumHeight = Number.POSITIVE_INFINITY,
	) {
		this.element = h(ownerDocument, "div");
	}

	layout(_bounds: IPositionedRectangle): void {}
}

class SerializableTestView extends TestView {
	constructor(
		ownerDocument: Document,
		readonly id: string,
	) {
		super(ownerDocument);
	}

	toJSON(): string {
		return this.id;
	}
}

test("Grid addresses topology mutations by view identity", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestView(dom.window.document, 100);
	const editor = new TestView(dom.window.document, 100);
	const panel = new TestView(dom.window.document, 100);
	const auxiliary = new TestView(dom.window.document, 100);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: editor, size: 600 },
		],
	});
	grid.layout(800, 600);

	grid.addView(panel, Sizing.Split, editor, Direction.Down);
	assert.deepEqual(grid.getViewSize(editor), { width: 600, height: 300 });
	assert.deepEqual(grid.getViewSize(panel), { width: 600, height: 300 });

	grid.addView(auxiliary, 100, editor, Direction.Right);
	assert.deepEqual(grid.getViewSize(auxiliary), { width: 100, height: 300 });

	grid.removeView(panel);
	assert.equal(panel.element.parentElement, null);
	assert.deepEqual(grid.getViewSize(editor), { width: 500, height: 600 });

	grid.moveView(auxiliary, 100, left, Direction.Left);
	assert.deepEqual(grid.getViewSize(auxiliary), { width: 100, height: 600 });
	assert.equal(auxiliary.element.parentElement?.style.left, "0px");
	assert.equal(left.element.parentElement?.style.left, "100px");

	grid.dispose();
	dom.window.close();
});

test("SerializableGrid persists a mutated GridView topology", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const editor = new SerializableTestView(dom.window.document, "editor");
	const panel = new SerializableTestView(dom.window.document, "panel");
	const grid = new SerializableGrid(dom.window.document.body, {
		type: "leaf",
		view: editor,
		size: 600,
	});
	grid.layout(800, 600);
	grid.addView(panel, Sizing.Split, editor, Direction.Down);

	const snapshot = grid.serialize();
	const restoredViews = new Map<string, SerializableTestView>();
	const restored = SerializableGrid.deserialize(
		dom.window.document.body,
		snapshot,
		{
			fromJSON(data) {
				if (typeof data !== "string") {
					throw new TypeError("Serialized test view ID must be a string");
				}
				const view = new SerializableTestView(dom.window.document, data);
				restoredViews.set(data, view);
				return view;
			},
		},
	);
	restored.layout(800, 600);

	assert.deepEqual(
		restored.getViewSize(restoredViews.get("editor")!),
		{ width: 800, height: 300 },
	);
	assert.deepEqual(
		restored.getViewSize(restoredViews.get("panel")!),
		{ width: 800, height: 300 },
	);

	restored.dispose();
	grid.dispose();
	dom.window.close();
});

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

const { Grid, SerializableGrid } = await import("../../browser/ui/grid/grid.js");

class TestGridView {
	readonly element: HTMLDivElement;
	readonly layouts: Array<{
		readonly width: number;
		readonly height: number;
		readonly top: number;
		readonly left: number;
	}> = [];
	visible = true;

	constructor(
		ownerDocument: Document,
		readonly minimumWidth: number,
		readonly maximumWidth: number,
		readonly minimumHeight = 0,
		readonly maximumHeight = Number.POSITIVE_INFINITY,
		readonly snap = false,
	) {
		this.element = h(ownerDocument, "div");
	}

	layout(bounds: IPositionedRectangle): void {
		this.layouts.push(bounds);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}
}

class SerializableTestGridView extends TestGridView {
	constructor(
		ownerDocument: Document,
		readonly id: string,
		minimumWidth: number,
		maximumWidth: number,
	) {
		super(ownerDocument, minimumWidth, maximumWidth);
	}

	toJSON(): string {
		return this.id;
	}
}

test("Grid lays out a nested SplitView tree in two dimensions", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestGridView(dom.window.document, 100, 600);
	const session = new TestGridView(dom.window.document, 120, Infinity, 36, 36);
	const editor = new TestGridView(dom.window.document, 120, Infinity, 84);
	const right = new TestGridView(dom.window.document, 100, 600);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{
				type: "branch",
				orientation: "vertical",
				size: 400,
				children: [
					{ type: "leaf", view: session, size: 36 },
					{ type: "leaf", view: editor, size: 564 },
				],
			},
			{ type: "leaf", view: right, size: 200 },
		],
	});

	grid.layout(800, 600);

	assert.deepEqual(left.layouts.at(-1), {
		width: 200,
		height: 600,
		top: 0,
		left: 0,
	});
	assert.deepEqual(session.layouts.at(-1), {
		width: 400,
		height: 36,
		top: 0,
		left: 200,
	});
	assert.deepEqual(editor.layouts.at(-1), {
		width: 400,
		height: 564,
		top: 36,
		left: 200,
	});
	assert.equal(grid.element.querySelectorAll(".ash-sash").length, 2);

	grid.dispose();
	dom.window.close();
});

test("Grid keeps hidden leaves mounted and restores their pixel size", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestGridView(dom.window.document, 100, 600);
	const editor = new TestGridView(dom.window.document, 120, Infinity);
	const right = new TestGridView(dom.window.document, 100, 600);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: editor, size: 400 },
			{ type: "leaf", view: right, size: 200 },
		],
	});
	grid.layout(800, 600);

	grid.setViewVisible(left, false);
	assert.equal(left.visible, false);
	assert.ok(left.element.parentElement);
	assert.deepEqual(grid.getViewSize(editor), { width: 500, height: 600 });

	grid.setViewVisible(left, true);
	assert.equal(left.visible, true);
	assert.deepEqual(grid.getViewSize(left), { width: 200, height: 600 });
	assert.deepEqual(grid.getViewSize(editor), { width: 400, height: 600 });

	grid.resizeView(left, { width: 250, height: 600 });
	assert.deepEqual(grid.getViewSize(left), { width: 250, height: 600 });

	grid.dispose();
	dom.window.close();
});

test("Grid wires nested SplitView intersections as corner sashes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestGridView(dom.window.document, 100, 600, 100, 600);
	const top = new TestGridView(dom.window.document, 100, 600, 100, 600);
	const bottom = new TestGridView(dom.window.document, 100, 600, 100, 600);
	const right = new TestGridView(dom.window.document, 100, 600, 100, 600);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{
				type: "branch",
				orientation: "vertical",
				size: 400,
				children: [
					{ type: "leaf", view: top, size: 300 },
					{ type: "leaf", view: bottom, size: 300 },
				],
			},
			{ type: "leaf", view: right, size: 200 },
		],
	});
	grid.layout(800, 600);
	const horizontalSash = grid.element.querySelector<HTMLElement>(".ash-sash-horizontal");
	assert.ok(horizontalSash);
	const startHandle = horizontalSash.querySelector<HTMLElement>(".ash-sash-orthogonal-handle-start");
	const endHandle = horizontalSash.querySelector<HTMLElement>(".ash-sash-orthogonal-handle-end");
	assert.ok(startHandle);
	assert.ok(endHandle);

	startHandle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 40 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 40 }));

	assert.deepEqual(grid.getViewSize(left), { width: 250, height: 600 });
	assert.deepEqual(grid.getViewSize(top), { width: 350, height: 340 });
	assert.deepEqual(grid.getViewSize(bottom), { width: 350, height: 260 });
	assert.deepEqual(grid.getViewSize(right), { width: 200, height: 600 });
	grid.dispose();
	dom.window.close();
});

test("Grid recursively projects inherited boundary sashes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const view = () => new TestGridView(dom.window.document, 50, 1_000, 50, 1_000);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: view(), size: 100 },
			{
				type: "branch",
				orientation: "vertical",
				size: 600,
				children: [
					{
						type: "branch",
						orientation: "horizontal",
						size: 300,
						children: [
							{
								type: "branch",
								orientation: "vertical",
								size: 300,
								children: [
									{ type: "leaf", view: view(), size: 150 },
									{ type: "leaf", view: view(), size: 150 },
								],
							},
							{ type: "leaf", view: view(), size: 300 },
						],
					},
					{ type: "leaf", view: view(), size: 300 },
				],
			},
			{ type: "leaf", view: view(), size: 100 },
		],
	});
	grid.layout(800, 600);
	const horizontalSashes = [...grid.element.querySelectorAll<HTMLElement>(".ash-sash-horizontal")];
	assert.equal(horizontalSashes.length, 2);
	for (const sash of horizontalSashes) {
		assert.ok(sash.querySelector(".ash-sash-orthogonal-handle-start"));
		assert.ok(sash.querySelector(".ash-sash-orthogonal-handle-end"));
	}
	const panes = [...grid.element.querySelectorAll<HTMLElement>(".ash-split-view-pane")];
	for (const pane of panes) {
		const hostsNestedSplitView = pane.firstElementChild?.classList.contains("ash-split-view") === true;
		assert.equal(pane.classList.contains("ash-split-view-pane-overflow-visible"), hostsNestedSplitView);
	}

	grid.dispose();
	dom.window.close();
});

test("Grid links aligned sashes in a 2 by 2 layout", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const topLeft = new TestGridView(dom.window.document, 100, 1_000, 100, 1_000);
	const topRight = new TestGridView(dom.window.document, 100, 1_000, 100, 1_000);
	const bottomLeft = new TestGridView(dom.window.document, 100, 1_000, 100, 1_000);
	const bottomRight = new TestGridView(dom.window.document, 100, 1_000, 100, 1_000);
	const row = (left: TestGridView, right: TestGridView) => ({
		type: "branch" as const,
		orientation: "horizontal" as const,
		size: 300,
		children: [
			{ type: "leaf" as const, view: left, size: 400 },
			{ type: "leaf" as const, view: right, size: 400 },
		],
	});
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "vertical",
		size: 600,
		children: [row(topLeft, topRight), row(bottomLeft, bottomRight)],
	});
	grid.layout(800, 600);
	const handle = grid.element.querySelector<HTMLElement>(".ash-sash-vertical .ash-sash-orthogonal-handle-end");
	assert.ok(handle);

	handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 30 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 30 }));

	assert.deepEqual(grid.getViewSize(topLeft), { width: 450, height: 330 });
	assert.deepEqual(grid.getViewSize(topRight), { width: 350, height: 330 });
	assert.deepEqual(grid.getViewSize(bottomLeft), { width: 450, height: 270 });
	assert.deepEqual(grid.getViewSize(bottomRight), { width: 350, height: 270 });
	grid.dispose();
	dom.window.close();
});

test("Grid edge snapping allows collapse but gates outer-edge restore", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const sidebar = new TestGridView(dom.window.document, 100, 400, 0, Infinity, true);
	const editor = new TestGridView(dom.window.document, 100, Infinity);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{ type: "leaf", view: sidebar, size: 100 },
			{ type: "leaf", view: editor, size: 500 },
		],
	});
	grid.layout(600, 300);
	assert.equal(grid.edgeSnapping, false);
	const sash = grid.element.querySelector<HTMLElement>(".ash-sash");
	assert.ok(sash);

	dragGridSash(dom.window, sash, -60);
	assert.equal(grid.isViewVisible(sidebar), false);
	assert.equal(sash.classList.contains("ash-sash-disabled"), true);
	grid.edgeSnapping = true;
	assert.equal(sash.classList.contains("ash-sash-minimum"), true);
	dragGridSash(dom.window, sash, 60);
	assert.equal(grid.isViewVisible(sidebar), true);

	grid.dispose();
	dom.window.close();
});

test("Grid resets a visible sash by distributing its sibling sizes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestGridView(dom.window.document, 100, 600);
	const right = new TestGridView(dom.window.document, 100, 600);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: right, size: 400 },
		],
	});
	grid.layout(600, 400);
	const sash = grid.element.querySelector<HTMLElement>(".ash-sash");
	assert.ok(sash);

	sash.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

	assert.deepEqual(grid.getViewSize(left), { width: 300, height: 400 });
	assert.deepEqual(grid.getViewSize(right), { width: 300, height: 400 });
	grid.dispose();
	dom.window.close();
});

test("Grid resets only the views adjacent to the selected sash", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new TestGridView(dom.window.document, 100, 600);
	const middle = new TestGridView(dom.window.document, 100, 600);
	const right = new TestGridView(dom.window.document, 100, 600);
	const grid = new Grid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 600,
		children: [
			{ type: "leaf", view: left, size: 100 },
			{ type: "leaf", view: middle, size: 300 },
			{ type: "leaf", view: right, size: 200 },
		],
	});
	grid.layout(600, 400);
	const sashes = grid.element.querySelectorAll<HTMLElement>(":scope > .ash-split-view > .ash-sash");
	const secondSash = sashes[1];
	assert.ok(secondSash);

	secondSash.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

	assert.deepEqual(grid.getViewSize(left), { width: 100, height: 400 });
	assert.deepEqual(grid.getViewSize(middle), { width: 250, height: 400 });
	assert.deepEqual(grid.getViewSize(right), { width: 250, height: 400 });
	grid.dispose();
	dom.window.close();
});

test("Grid rejects duplicate views in its descriptor", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const view = new TestGridView(dom.window.document, 0, Infinity);
	assert.throws(
		() => new Grid(dom.window.document.body, {
			type: "branch",
			orientation: "horizontal",
			size: 200,
			children: [
				{ type: "leaf", view, size: 100 },
				{ type: "leaf", view, size: 100 },
			],
		}),
		/same view twice/,
	);
	dom.window.close();
});

test("SerializableGrid restores view identity and runtime geometry", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const left = new SerializableTestGridView(dom.window.document, "left", 100, 600);
	const editor = new SerializableTestGridView(dom.window.document, "editor", 120, Infinity);
	const right = new SerializableTestGridView(dom.window.document, "right", 100, 600);
	const grid = new SerializableGrid(dom.window.document.body, {
		type: "branch",
		orientation: "horizontal",
		size: 800,
		children: [
			{ type: "leaf", view: left, size: 200 },
			{ type: "leaf", view: editor, size: 400, priority: "high" },
			{ type: "leaf", view: right, size: 200 },
		],
	});
	grid.layout(900, 600);
	grid.resizeView(right, { width: 250, height: 600 });
	grid.setViewVisible(left, false);

	const snapshot = grid.serialize();
	const restoredViews = new Map<string, SerializableTestGridView>();
	const restored = SerializableGrid.deserialize(
		dom.window.document.body,
		snapshot,
		{
			fromJSON: (data) => {
				if (typeof data !== "string") {
					throw new TypeError("Serialized test view ID must be a string");
				}
				const view = new SerializableTestGridView(
					dom.window.document,
					data,
					data === "editor" ? 120 : 100,
					data === "editor" ? Infinity : 600,
				);
				restoredViews.set(data, view);
				return view;
			},
		},
	);
	restored.layout(900, 600);

	assert.equal(restored.isViewVisible(restoredViews.get("left")!), false);
	assert.equal(restored.getViewSize(restoredViews.get("editor")!).width, 650);
	assert.equal(restored.getViewSize(restoredViews.get("right")!).width, 250);

	restored.dispose();
	grid.dispose();
	dom.window.close();
});

function dragGridSash(targetWindow: typeof browserEnvironment.window, sash: HTMLElement, delta: number): void {
	const vertical = sash.classList.contains("ash-sash-vertical");
	const event = (type: string, coordinate: number) => new targetWindow.MouseEvent(type, {
		bubbles: true,
		button: 0,
		clientX: vertical ? coordinate : 0,
		clientY: vertical ? 0 : coordinate,
	});
	sash.dispatchEvent(event("pointerdown", 0));
	targetWindow.dispatchEvent(event("pointermove", delta));
	targetWindow.dispatchEvent(event("pointerup", delta));
}

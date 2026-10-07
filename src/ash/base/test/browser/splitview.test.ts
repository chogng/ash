import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
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

const { SplitView } = await import(
	"../../browser/ui/splitview/splitview.js"
);

class TestView {
	readonly element: HTMLDivElement;
	readonly layouts: Array<{
		readonly size: number;
		readonly offset: number;
		readonly orthogonalSize: number;
	}> = [];
	visible = true;

	constructor(
		ownerDocument: Document,
		readonly minimumSize: number,
		readonly maximumSize: number,
		readonly snap = false,
	) {
		this.element = h(ownerDocument, "div");
	}

	layout(size: number, offset: number, orthogonalSize: number): void {
		this.layouts.push({ size, offset, orthogonalSize });
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}
}

test("SplitView owns constrained pixel sizes and positions", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	const fixed = new TestView(dom.window.document, 35, 35);
	const center = new TestView(dom.window.document, 100, Infinity);
	const side = new TestView(dom.window.document, 180, 600);
	split.addView(fixed, 35);
	split.addView(center, 100);
	split.addView(side, 220);

	split.layout(500, 300);

	assert.equal(split.viewCount, 3);
	assert.deepEqual(
		[0, 1, 2].map((index) => split.getViewSize(index)),
		[35, 172.5, 292.5],
	);
	assert.equal(split.element.querySelectorAll(".ash-sash").length, 1);
	const panes = split.element.querySelectorAll<HTMLElement>(
		".ash-split-view-pane",
	);
	assert.equal(panes[0]?.style.left, "0px");
	assert.equal(panes[1]?.style.left, "35px");
	assert.equal(panes[2]?.style.left, "207.5px");
	assert.equal(panes[2]?.style.width, "292.5px");
	assert.deepEqual(side.layouts.at(-1), {
		size: 292.5,
		offset: 207.5,
		orthogonalSize: 300,
	});

	split.dispose();
	dom.window.close();
});

test("SplitView clamps absolute sash drag deltas without boundary jumps", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 260), 200);
	split.addView(new TestView(dom.window.document, 100, Infinity), 200);
	split.layout(400, 100);
	const sash = split.element.querySelector<HTMLElement>(".ash-sash");
	assert.ok(sash);

	sash.dispatchEvent(pointerEvent(dom.window, "pointerdown", 0));
	dom.window.dispatchEvent(pointerEvent(dom.window, "pointermove", 150));
	dom.window.dispatchEvent(pointerEvent(dom.window, "pointermove", 140));
	dom.window.dispatchEvent(pointerEvent(dom.window, "pointerup", 140));

	assert.deepEqual(
		[split.getViewSize(0), split.getViewSize(1)],
		[260, 140],
	);

	split.dispose();
	dom.window.close();
});

test("SplitView retains and restores hidden view size", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	const sidebar = new TestView(dom.window.document, 180, 600);
	const editor = new TestView(dom.window.document, 120, Infinity);
	split.addView(sidebar, 220);
	split.addView(editor, 580);
	split.layout(800, 600);

	split.setViewVisible(0, false);
	assert.equal(split.getViewCachedVisibleSize(0), 220);
	assert.equal(split.getViewSize(1), 800);
	assert.equal(sidebar.visible, false);
	assert.equal(sidebar.element.parentElement?.parentElement, split.element);

	split.setViewVisible(0, true);
	assert.equal(split.getViewSize(0), 220);
	assert.equal(split.getViewSize(1), 580);
	assert.equal(sidebar.visible, true);

	split.dispose();
	dom.window.close();
});

test("SplitView snaps a leading view closed and restores it from the edge sash", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	const sidebar = new TestView(dom.window.document, 180, 600, true);
	split.addView(sidebar, 220);
	split.addView(new TestView(dom.window.document, 120, Infinity), 580);
	split.layout(800, 600);

	dragSash(dom.window, requiredSash(split.element), -140);

	assert.equal(split.isViewVisible(0), false);
	assert.equal(split.getViewCachedVisibleSize(0), 220);
	assert.equal(sidebar.visible, false);
	assert.equal(requiredSash(split.element).style.left, "0px");

	dragSash(dom.window, requiredSash(split.element), 100);

	assert.equal(split.isViewVisible(0), true);
	assert.equal(split.getViewSize(0), 180);
	assert.equal(split.getViewSize(1), 620);
	assert.equal(sidebar.visible, true);

	split.dispose();
	dom.window.close();
});

test("SplitView snaps a trailing view closed and restores it from the edge sash", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "vertical");
	const panel = new TestView(dom.window.document, 80, Infinity, true);
	split.addView(new TestView(dom.window.document, 120, Infinity), 500);
	split.addView(panel, 200);
	split.layout(700, 900);

	dragSash(dom.window, requiredSash(split.element), 170);

	assert.equal(split.isViewVisible(1), false);
	assert.equal(split.getViewCachedVisibleSize(1), 200);
	assert.equal(panel.visible, false);
	assert.equal(requiredSash(split.element).style.top, "700px");

	dragSash(dom.window, requiredSash(split.element), -50);

	assert.equal(split.isViewVisible(1), true);
	assert.equal(split.getViewSize(0), 620);
	assert.equal(split.getViewSize(1), 80);
	assert.equal(panel.visible, true);

	split.dispose();
	dom.window.close();
});

test("SplitView sashes support keyboard resizing", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 40, Infinity), 100);
	split.addView(new TestView(dom.window.document, 40, Infinity), 100);
	split.layout(200, 100);
	const sash = split.element.querySelector<HTMLElement>(".ash-sash");
	assert.ok(sash);

	sash.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		key: "ArrowRight",
	}));

	assert.deepEqual(
		[split.getViewSize(0), split.getViewSize(1)],
		[110, 90],
	);

	split.dispose();
	dom.window.close();
});

test("SplitView Alt-drag resizes the enclosed pane symmetrically", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.layout(600, 200);
	const sash = split.element.querySelectorAll<HTMLElement>(":scope > .ash-sash")[0];
	assert.ok(sash);

	dragSash(dom.window, sash, 30, true);

	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [230, 140, 230]);
	split.dispose();
	dom.window.close();
});

test("SplitView rebases an active drag when Alt changes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.layout(600, 200);
	const sash = requiredSash(split.element);

	sash.dispatchEvent(dragEvent(dom.window, sash, "pointerdown", 0));
	dom.window.dispatchEvent(dragEvent(dom.window, sash, "pointermove", 30));
	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [230, 170, 200]);
	dom.window.dispatchEvent(dragEvent(dom.window, sash, "pointermove", 31, true));
	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [230, 170, 200]);
	dom.window.dispatchEvent(dragEvent(dom.window, sash, "pointermove", 41, true));
	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [240, 150, 210]);
	dom.window.dispatchEvent(dragEvent(dom.window, sash, "pointermove", 42));
	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [240, 150, 210]);
	dom.window.dispatchEvent(dragEvent(dom.window, sash, "pointerup", 42));

	split.dispose();
	dom.window.close();
});

test("SplitView keeps a snap sash stable while its view hides and restores", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	dom.window.document.body.append(split.element);
	split.addView(new TestView(dom.window.document, 100, 400, true), 160);
	split.addView(new TestView(dom.window.document, 100, Infinity), 440);
	split.layout(600, 200);
	const sash = requiredSash(split.element);
	sash.focus();

	dragSash(dom.window, sash, -120);
	assert.equal(split.isViewVisible(0), false);
	assert.equal(requiredSash(split.element), sash);
	assert.equal(dom.window.document.activeElement, sash);
	assert.equal(sash.classList.contains("ash-sash-minimum"), true);

	dragSash(dom.window, sash, 60);
	assert.equal(split.isViewVisible(0), true);
	assert.equal(requiredSash(split.element), sash);
	assert.equal(dom.window.document.activeElement, sash);

	split.dispose();
	dom.window.close();
});

test("SplitView keyboard resizing crosses snap boundaries", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 400, true), 100);
	split.addView(new TestView(dom.window.document, 100, Infinity), 500);
	split.layout(600, 200);
	const sash = requiredSash(split.element);

	sash.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
	assert.equal(split.isViewVisible(0), false);
	sash.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
	assert.equal(split.isViewVisible(0), true);
	assert.equal(split.getViewSize(0), 100);

	split.dispose();
	dom.window.close();
});

test("SplitView disables a hidden outer snap sash when edge snapping is disabled", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal", { startSnappingEnabled: false });
	split.addView(new TestView(dom.window.document, 100, 400, true), 140);
	split.addView(new TestView(dom.window.document, 100, Infinity), 460);
	split.layout(600, 200);
	const sash = requiredSash(split.element);

	dragSash(dom.window, sash, -100);
	assert.equal(split.isViewVisible(0), false);

	assert.equal(sash.classList.contains("ash-sash-disabled"), true);
	assert.equal(sash.getAttribute("aria-disabled"), "true");
	dragSash(dom.window, sash, 60);
	assert.equal(split.isViewVisible(0), false);

	split.startSnappingEnabled = true;
	assert.equal(sash.classList.contains("ash-sash-minimum"), true);
	dragSash(dom.window, sash, 60);
	assert.equal(split.isViewVisible(0), true);

	split.dispose();
	dom.window.close();
});

test("SplitView uses VS Code trailing snap threshold boundaries", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, Infinity), 500);
	split.addView(new TestView(dom.window.document, 100, 400, true), 100);
	split.layout(600, 200);
	const sash = requiredSash(split.element);

	dragSash(dom.window, sash, 50);
	assert.equal(split.isViewVisible(1), false);
	dragSash(dom.window, sash, -50);
	assert.equal(split.isViewVisible(1), false);
	dragSash(dom.window, sash, -51);
	assert.equal(split.isViewVisible(1), true);

	split.dispose();
	dom.window.close();
});

test("SplitView emits reset for a visible logical boundary", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.addView(new TestView(dom.window.document, 100, 400), 200);
	split.layout(400, 200);
	let resetBoundary = -1;
	split.onDidSashReset((index) => resetBoundary = index);

	requiredSash(split.element).dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

	assert.equal(resetBoundary, 0);
	split.dispose();
	dom.window.close();
});

test("SplitView resize crosses adjacent constraints into farther panes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, 300), 150);
	split.addView(new TestView(dom.window.document, 100, 160), 150);
	split.addView(new TestView(dom.window.document, 100, 400), 300);
	split.layout(600, 200);
	const sashes = split.element.querySelectorAll<HTMLElement>(":scope > .ash-sash");
	const first = sashes[0];
	assert.ok(first);

	dragSash(dom.window, first, 100);

	assert.deepEqual([split.getViewSize(0), split.getViewSize(1), split.getViewSize(2)], [250, 100, 250]);
	split.dispose();
	dom.window.close();
});

test("SplitView exposes only the sash next to a run of hidden snap views", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	split.addView(new TestView(dom.window.document, 100, Infinity), 400);
	split.addView(new TestView(dom.window.document, 100, 400, true), 200);
	split.addView(new TestView(dom.window.document, 100, 400, true), { type: "invisible", cachedVisibleSize: 200 });
	split.layout(600, 200);
	split.setViewVisible(1, false);
	const sashes = split.element.querySelectorAll<HTMLElement>(":scope > .ash-sash");
	assert.equal(sashes.length, 2);

	assert.equal(sashes[0]?.classList.contains("ash-sash-maximum"), true);
	assert.equal(sashes[1]?.classList.contains("ash-sash-disabled"), true);
	dragSash(dom.window, sashes[0]!, -60);
	assert.equal(split.isViewVisible(1), true);
	assert.equal(sashes[1]?.classList.contains("ash-sash-maximum"), true);

	dragSash(dom.window, sashes[1]!, -60);
	assert.equal(split.isViewVisible(2), true);
	split.dispose();
	dom.window.close();
});

test("SplitView publishes snap visibility after applying the complete resize", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	const observedSizes: number[][] = [];
	class ObservingView extends TestView {
		override setVisible(visible: boolean): void {
			super.setVisible(visible);
			if (visible && split.viewCount === 2) {
				observedSizes.push([split.getViewSize(0), split.getViewSize(1)]);
			}
		}
	}
	split.addView(new TestView(dom.window.document, 100, Infinity), 400);
	split.addView(new ObservingView(dom.window.document, 100, 500, true), 200);
	split.layout(600, 200);
	observedSizes.length = 0;
	const sash = requiredSash(split.element);
	dragSash(dom.window, sash, 160);
	dragSash(dom.window, sash, -60);

	assert.deepEqual(observedSizes, [[500, 100]]);
	split.dispose();
	dom.window.close();
});

test("SplitView validates view constraints before mounting", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const split = new SplitView(dom.window.document.body, "horizontal");
	assert.throws(
		() => split.addView(
			new TestView(dom.window.document, 100, 40),
			100,
		),
		/maximum size/,
	);
	assert.equal(split.viewCount, 0);
	split.dispose();
	dom.window.close();
});

function pointerEvent(
	targetWindow: typeof browserEnvironment.window,
	type: string,
	clientX: number,
): Event {
	return new targetWindow.MouseEvent(type, {
		bubbles: true,
		button: 0,
		clientX,
	});
}

function requiredSash(container: HTMLElement): HTMLElement {
	const sash = container.querySelector<HTMLElement>(":scope > .ash-sash");
	assert.ok(sash);
	return sash;
}

function dragSash(
	targetWindow: typeof browserEnvironment.window,
	sash: HTMLElement,
	delta: number,
	altKey = false,
): void {
	sash.dispatchEvent(dragEvent(targetWindow, sash, "pointerdown", 0, altKey));
	targetWindow.dispatchEvent(dragEvent(targetWindow, sash, "pointermove", delta, altKey));
	targetWindow.dispatchEvent(dragEvent(targetWindow, sash, "pointerup", delta, altKey));
}

function dragEvent(targetWindow: typeof browserEnvironment.window, sash: HTMLElement, type: string, coordinate: number, altKey = false): MouseEvent {
	const vertical = sash.classList.contains("ash-sash-vertical");
	return new targetWindow.MouseEvent(type, {
		bubbles: true,
		button: 0,
		altKey,
		clientX: vertical ? coordinate : 0,
		clientY: vertical ? 0 : coordinate,
	});
}

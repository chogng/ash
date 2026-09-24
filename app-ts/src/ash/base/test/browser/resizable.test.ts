import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { Dimension } = await import("../../browser/dom.js");
const { Emitter } = await import("../../common/event.js");
const { bindResizableLayout, ResizableHTMLElement } = await import(
	"../../browser/ui/resizable/resizable.js",
);

test("ResizableHTMLElement constrains and positions its edge sashes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const resizable = new ResizableHTMLElement(dom.window.document.body);
	dom.window.document.body.append(resizable.domNode);
	resizable.minSize = new Dimension(80, 60);
	resizable.maxSize = new Dimension(300, 200);
	resizable.layout(100, 200);
	resizable.enableSashes(false, true, true, false);

	assert.deepEqual(resizable.size, new Dimension(200, 100));
	assert.equal(resizable.domNode.style.width, "200px");
	assert.equal(resizable.domNode.style.height, "100px");
	const sashes = resizable.domNode.querySelectorAll<HTMLElement>(".ash-sash");
	assert.equal(sashes.length, 4);
	assert.equal(sashes[0]?.classList.contains("ash-sash-disabled"), true);
	assert.equal(sashes[0]?.getAttribute("aria-disabled"), "true");
	assert.equal(sashes[1]?.classList.contains("ash-sash-disabled"), false);
	assert.equal(sashes[2]?.classList.contains("ash-sash-disabled"), false);
	assert.equal(sashes[3]?.classList.contains("ash-sash-disabled"), true);
	assert.equal(sashes[1]?.style.left, "200px");
	assert.equal(sashes[1]?.style.height, "100px");
	assert.equal(sashes[2]?.style.top, "100px");
	assert.equal(sashes[2]?.style.width, "200px");

	resizable.layout(500, 500);
	assert.deepEqual(resizable.size, new Dimension(300, 200));
	assert.throws(() => {
		resizable.minSize = new Dimension(301, 60);
	}, RangeError);
	resizable.maxSize = new Dimension(Infinity, Infinity);
	resizable.preferredSize = new Dimension(220, 120);
	sashes[1]?.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
	sashes[2]?.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
	assert.deepEqual(resizable.size, new Dimension(220, 120));

	resizable.dispose();
	dom.window.close();
});

test("ResizableHTMLElement reports edge drag lifecycle", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const resizable = new ResizableHTMLElement(dom.window.document.body);
	dom.window.document.body.append(resizable.domNode);
	resizable.layout(100, 200);
	resizable.enableSashes(false, true, false, false);
	const events: Array<{ readonly done: boolean; readonly east?: boolean; readonly width: number }> = [];
	let willResize = 0;
	resizable.onDidWillResize(() => willResize++);
	resizable.onDidResize((event) => {
		events.push({ done: event.done, east: event.east, width: event.dimension.width });
	});

	const east = resizable.domNode.querySelector<HTMLElement>(".ash-sash-vertical");
	assert.ok(east);
	east.dispatchEvent(new dom.window.MouseEvent("pointerdown", {
		bubbles: true,
		button: 0,
		clientX: 0,
	}));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", {
		clientX: 40,
	}));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", {
		clientX: 40,
	}));

	assert.equal(willResize, 1);
	assert.deepEqual(events, [
		{ done: false, east: true, width: 240 },
		{ done: true, east: undefined, width: 240 },
	]);
	assert.deepEqual(resizable.size, new Dimension(240, 100));

	resizable.dispose();
	dom.window.close();
});

test("bindResizableLayout connects and releases a generic layout target", () => {
	const emitter = new Emitter<{ readonly width: number; readonly height: number }>();
	const dimensions: Array<{ readonly width: number; readonly height: number }> = [];
	const registration = bindResizableLayout(emitter.event, {
		layout: (dimension) => dimensions.push(dimension),
	});

	emitter.fire({ width: 640, height: 480 });
	registration.dispose();
	emitter.fire({ width: 800, height: 600 });

	assert.deepEqual(dimensions, [{ width: 640, height: 480 }]);
	emitter.dispose();
});

browserEnvironment.window.close();

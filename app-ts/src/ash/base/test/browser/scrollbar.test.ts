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
	MouseEvent: browserEnvironment.window.MouseEvent,
	PointerEvent: browserEnvironment.window.MouseEvent,
	WheelEvent: browserEnvironment.window.WheelEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { ScrollableElement, Scrollbar } = await import(
	"../../browser/ui/scrollbar/scrollbar.js"
);

test("ScrollableElement exposes a persistent directional content container", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollable = new ScrollableElement(dom.window.document.body, {
		direction: "horizontal",
	});
	const first = h(dom.window.document, "span");
	const second = h(dom.window.document, "span");
	scrollable.replaceChildren(first);
	scrollable.append(second);
	assert.equal(scrollable.contentElement.parentElement, scrollable.scrollableElement);
	assert.deepEqual([...scrollable.contentElement.children], [first, second]);
	installMetrics(scrollable.scrollableElement, {
		width: 100,
		height: 50,
		scrollWidth: 300,
		scrollHeight: 400,
	});
	scrollable.layout();

	assert.equal(scrollable.state.maximumLeft, 200);
	assert.equal(scrollable.state.maximumTop, 0);
	assert.equal(
		requireElement(
			scrollable.element,
			".ash-scrollbar-track-vertical",
		).hidden,
		true,
	);
	scrollable.scrollableElement.dispatchEvent(wheelEvent(dom.window, {
		deltaY: 25,
	}));
	assert.equal(scrollable.state.left, 25);
	assert.equal(scrollable.state.top, 0);

	scrollable.dispose();
	dom.window.close();
});

test("ScrollableElement reveals a descendant at the nearest horizontal edge", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollable = new ScrollableElement(dom.window.document.body, {
		direction: "horizontal",
	});
	const item = h(dom.window.document, "span");
	scrollable.append(item);
	dom.window.document.body.append(scrollable.element);
	scrollable.reveal(item);
	installMetrics(scrollable.scrollableElement, {
		width: 100,
		height: 50,
		scrollWidth: 300,
		scrollHeight: 50,
	});
	scrollable.scrollableElement.getBoundingClientRect = () => rect(0, 0, 100, 50);
	item.getBoundingClientRect = () => rect(150, 0, 200, 20);
	scrollable.layout();

	assert.equal(scrollable.state.left, 100);
	assert.equal(scrollable.state.top, 0);
	assert.throws(
		() => scrollable.reveal(h(dom.window.document, "span")),
		/only reveal its descendants/,
	);
	scrollable.dispose();
	dom.window.close();
});

test("Scrollbar owns two-axis state, elements, visibility, and ARIA", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollbar = new Scrollbar(dom.window.document.body, {
		ariaLabel: "Scrollable test",
	});
	dom.window.document.body.append(scrollbar.element);
	const viewport = requireElement(
		scrollbar.element,
		".ash-scrollbar-viewport",
	);
	installMetrics(viewport, {
		width: 200,
		height: 100,
		scrollWidth: 600,
		scrollHeight: 400,
	});

	scrollbar.layout();

	assert.deepEqual(scrollbar.state, {
		left: 0,
		top: 0,
		width: 200,
		height: 100,
		scrollWidth: 600,
		scrollHeight: 400,
		maximumLeft: 400,
		maximumTop: 300,
	});
	const horizontal = requireElement(
		scrollbar.element,
		".ash-scrollbar-track-horizontal",
	);
	const vertical = requireElement(
		scrollbar.element,
		".ash-scrollbar-track-vertical",
	);
	const horizontalThumb = requireElement(
		horizontal,
		".ash-scrollbar-thumb",
	);
	const verticalThumb = requireElement(
		vertical,
		".ash-scrollbar-thumb",
	);
	assert.equal(horizontal.hidden, false);
	assert.equal(vertical.hidden, false);
	assert.equal(horizontal.getAttribute("role"), "scrollbar");
	assert.equal(horizontal.getAttribute("aria-orientation"), "horizontal");
	assert.equal(
		horizontal.getAttribute("aria-controls"),
		viewport.id,
	);
	assert.equal(horizontalThumb.style.width, "63.333333333333336px");
	assert.equal(verticalThumb.style.height, "22.5px");

	scrollbar.dispose();
	dom.window.close();
});

test("Scrollbar normalizes wheel input and propagates at boundaries", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const positions: Array<{ readonly left: number; readonly top: number }> = [];
	const changes: Array<{
		readonly previous: { readonly left: number; readonly top: number };
		readonly current: { readonly left: number; readonly top: number };
	}> = [];
	const scrollbar = new Scrollbar(dom.window.document.body, {
		onScroll: (position) => positions.push(position),
	});
	const registration = scrollbar.onDidScroll((event) => {
		changes.push({
			previous: event.previous,
			current: event.current,
		});
	});
	dom.window.document.body.append(scrollbar.element);
	const viewport = requireElement(
		scrollbar.element,
		".ash-scrollbar-viewport",
	);
	installMetrics(viewport, {
		width: 200,
		height: 100,
		scrollWidth: 600,
		scrollHeight: 400,
	});
	scrollbar.layout();
	const lineWheel = wheelEvent(dom.window, {
		deltaX: 1,
		deltaY: 2,
		deltaMode: 1,
	});

	viewport.dispatchEvent(lineWheel);

	assert.equal(lineWheel.defaultPrevented, true);
	assert.deepEqual(scrollbar.state, {
		left: 0,
		top: 32,
		width: 200,
		height: 100,
		scrollWidth: 600,
		scrollHeight: 400,
		maximumLeft: 400,
		maximumTop: 300,
	});
	assert.deepEqual(positions.at(-1), { left: 0, top: 32 });
	assert.deepEqual(changes.at(-1), {
		previous: { left: 0, top: 0 },
		current: {
			left: 0,
			top: 32,
			width: 200,
			height: 100,
			scrollWidth: 600,
			scrollHeight: 400,
			maximumLeft: 400,
			maximumTop: 300,
		},
	});

	scrollbar.scrollTo(0, scrollbar.state.maximumTop);
	const boundaryWheel = wheelEvent(dom.window, { deltaY: 10 });
	viewport.dispatchEvent(boundaryWheel);
	assert.equal(boundaryWheel.defaultPrevented, false);

	const shiftWheel = wheelEvent(dom.window, {
		deltaY: 25,
		shiftKey: true,
	});
	viewport.dispatchEvent(shiftWheel);
	assert.equal(scrollbar.state.left, 25);
	assert.equal(scrollbar.state.top, 300);

	registration.dispose();
	scrollbar.dispose();
	dom.window.close();
});

test("Scrollbar supports keyboard, track clicks, and thumb dragging", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollbar = new Scrollbar(dom.window.document.body, {
		horizontal: "hidden",
		vertical: "visible",
	});
	dom.window.document.body.append(scrollbar.element);
	const viewport = requireElement(
		scrollbar.element,
		".ash-scrollbar-viewport",
	);
	installMetrics(viewport, {
		width: 200,
		height: 100,
		scrollWidth: 200,
		scrollHeight: 400,
	});
	scrollbar.layout();
	const vertical = requireElement(
		scrollbar.element,
		".ash-scrollbar-track-vertical",
	);
	const horizontal = requireElement(
		scrollbar.element,
		".ash-scrollbar-track-horizontal",
	);
	const thumb = requireElement(vertical, ".ash-scrollbar-thumb");
	assert.equal(horizontal.hidden, true);
	assert.equal(vertical.hidden, false);
	vertical.getBoundingClientRect = () => ({
		x: 190,
		y: 0,
		top: 0,
		right: 200,
		bottom: 100,
		left: 190,
		width: 10,
		height: 100,
		toJSON() {},
	});

	vertical.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "PageDown",
	}));
	assert.equal(scrollbar.state.top, 100);

	vertical.dispatchEvent(pointerEvent(
		dom.window,
		"pointerdown",
		75,
	));
	assert.equal(scrollbar.state.top, 250);

	scrollbar.scrollTo(0, 0);
	thumb.dispatchEvent(pointerEvent(
		dom.window,
		"pointerdown",
		0,
	));
	dom.window.dispatchEvent(pointerEvent(
		dom.window,
		"pointermove",
		25,
	));
	dom.window.dispatchEvent(pointerEvent(
		dom.window,
		"pointerup",
		25,
	));
	assert.equal(scrollbar.state.top, 100);
	assert.equal(vertical.dataset.active, undefined);

	scrollbar.dispose();
	dom.window.close();
});

test("Horizontal scrollbar supports keyboard, track clicks, and thumb dragging", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollbar = new Scrollbar(dom.window.document.body, {
		direction: "horizontal",
		horizontal: "visible",
	});
	dom.window.document.body.append(scrollbar.element);
	const viewport = requireElement(
		scrollbar.element,
		".ash-scrollbar-viewport",
	);
	installMetrics(viewport, {
		width: 200,
		height: 100,
		scrollWidth: 600,
		scrollHeight: 100,
	});
	scrollbar.layout();
	const horizontal = requireElement(
		scrollbar.element,
		".ash-scrollbar-track-horizontal",
	);
	const thumb = requireElement(horizontal, ".ash-scrollbar-thumb");
	horizontal.getBoundingClientRect = () => rect(0, 90, 200, 100);

	horizontal.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "ArrowRight",
	}));
	assert.equal(scrollbar.state.left, 40);

	horizontal.dispatchEvent(horizontalPointerEvent(dom.window, "pointerdown", 150));
	assert.equal(Math.round(scrollbar.state.left), 350);

	scrollbar.scrollTo(0, 0);
	thumb.dispatchEvent(horizontalPointerEvent(dom.window, "pointerdown", 0));
	dom.window.dispatchEvent(horizontalPointerEvent(dom.window, "pointermove", 25));
	dom.window.dispatchEvent(horizontalPointerEvent(dom.window, "pointerup", 25));
	assert.equal(Math.round(scrollbar.state.left), 75);
	assert.equal(horizontal.dataset.active, undefined);

	scrollbar.dispose();
	dom.window.close();
});

test("Scrollbar can always consume wheel input", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const scrollbar = new Scrollbar(dom.window.document.body, {
		wheel: { consume: "always" },
	});
	const viewport = requireElement(
		scrollbar.element,
		".ash-scrollbar-viewport",
	);
	installMetrics(viewport, {
		width: 100,
		height: 100,
		scrollWidth: 100,
		scrollHeight: 100,
	});
	scrollbar.layout();
	const wheel = wheelEvent(dom.window, { deltaY: 10 });

	viewport.dispatchEvent(wheel);

	assert.equal(wheel.defaultPrevented, true);
	scrollbar.dispose();
	dom.window.close();
});

function requireElement(
	parent: ParentNode,
	selector: string,
): HTMLElement {
	const element = parent.querySelector<HTMLElement>(selector);
	assert.ok(element);
	return element;
}

function installMetrics(
	viewport: HTMLElement,
	metrics: {
		readonly width: number;
		readonly height: number;
		readonly scrollWidth: number;
		readonly scrollHeight: number;
	},
): void {
	Object.defineProperties(viewport, {
		clientWidth: {
			configurable: true,
			get: () => metrics.width,
		},
		clientHeight: {
			configurable: true,
			get: () => metrics.height,
		},
		scrollWidth: {
			configurable: true,
			get: () => metrics.scrollWidth,
		},
		scrollHeight: {
			configurable: true,
			get: () => metrics.scrollHeight,
		},
	});
}

function wheelEvent(
	targetWindow: typeof browserEnvironment.window,
	options: WheelEventInit,
): WheelEvent {
	return new targetWindow.WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		...options,
	}) as unknown as WheelEvent;
}

function pointerEvent(
	targetWindow: typeof browserEnvironment.window,
	type: string,
	clientY: number,
): PointerEvent {
	return new targetWindow.MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		cancelable: true,
		clientY,
	}) as unknown as PointerEvent;
}

function horizontalPointerEvent(
	targetWindow: typeof browserEnvironment.window,
	type: string,
	clientX: number,
): PointerEvent {
	return new targetWindow.MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		cancelable: true,
		clientX,
	}) as unknown as PointerEvent;
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
	return {
		left,
		top,
		right,
		bottom,
		x: left,
		y: top,
		width: right - left,
		height: bottom - top,
		toJSON: () => ({}),
	} as DOMRect;
}

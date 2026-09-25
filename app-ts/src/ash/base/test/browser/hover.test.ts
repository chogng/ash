import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../browser/dom.js";

const environment = new JSDOM("<!doctype html><html><body><main></main><button id='target' title='Native title'>Target</button></body></html>");
Object.defineProperties(globalThis, {
	window: { configurable: true, value: environment.window },
	document: { configurable: true, value: environment.window.document },
	Node: { configurable: true, value: environment.window.Node },
});
Object.defineProperties(environment.window, {
	innerWidth: { configurable: true, value: 800 },
	innerHeight: { configurable: true, value: 600 },
});

const { ContextView } = await import("../../browser/ui/contextview/contextview.js");
const { Hover } = await import("../../browser/ui/hover/hover.js");

test("Hover replaces native title with managed accessible content", () => {
	const container = requiredElement<HTMLElement>("main");
	const target = requiredElement<HTMLButtonElement>("#target");
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	target.getBoundingClientRect = () => rectangle(20, 60, 80, 24);
	const hover = new Hover({
		target,
		content: "Managed title",
		contextViewProvider: contextView,
	});

	assert.equal(target.hasAttribute("title"), false);
	hover.show();
	const tooltip = contextView.element.querySelector<HTMLElement>(".ash-hover");
	assert.ok(tooltip);
	assert.equal(contextView.element.classList.contains("ash-context-view-hover"), true);
	assert.equal(tooltip.textContent, "Managed title");
	assert.equal(tooltip.getAttribute("role"), "tooltip");
	assert.equal(target.getAttribute("aria-describedby"), tooltip.id);
	assert.equal(contextView.element.style.left, "0px");
	assert.equal(contextView.element.classList.contains("ash-context-view-align-center"), true);

	hover.update("Updated title");
	assert.equal(tooltip.textContent, "Updated title");
	hover.hide();
	assert.equal(target.hasAttribute("aria-describedby"), false);
	hover.dispose();
	assert.equal(target.title, "Native title");
	contextView.dispose();
});

test("Hover skips empty content and sticky persistence requires explicit dismissal", async () => {
	const container = requiredElement<HTMLElement>("main");
	const target = requiredElement<HTMLButtonElement>("#target");
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	target.getBoundingClientRect = () => rectangle(20, 60, 80, 24);
	let content: string | undefined;
	const hover = new Hover({
		target,
		content: () => content,
		delayMs: 0,
		persistence: "sticky",
		contextViewProvider: contextView,
	});

	hover.show();
	assert.equal(hover.visible, false);
	content = "Sticky title";
	target.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	await nextTimer();
	assert.equal(hover.visible, true);
	target.dispatchEvent(new environment.window.MouseEvent("pointerleave"));
	await nextTimer();
	assert.equal(hover.visible, true);
	hover.hide();
	assert.equal(hover.visible, false);

	hover.dispose();
	contextView.dispose();
});

test("Hover closes an in-flight ContextView when target layout disposes it", () => {
	const container = requiredElement<HTMLElement>("main");
	const target = h(environment.window.document, "button");
	container.append(target);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	const hover = new Hover({
		target,
		content: "Transient title",
		contextViewProvider: contextView,
	});
	target.getBoundingClientRect = () => {
		hover.dispose();
		target.remove();
		return rectangle(20, 60, 80, 24);
	};

	assert.doesNotThrow(() => hover.show());
	assert.equal(contextView.visible, false);
	assert.doesNotThrow(() => contextView.show({
		anchor: rectangle(40, 80, 0, 0),
		content: h(environment.window.document, "div"),
	}));
	assert.equal(contextView.visible, true);

	contextView.dispose();
});

function requiredElement<T extends Element>(selector: string): T {
	const element = environment.window.document.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

async function nextTimer(): Promise<void> {
	await new Promise<void>((resolve) => environment.window.setTimeout(resolve, 5));
}

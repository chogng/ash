import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { ContextViewHideReason as ContextViewHideReasonValue } from "../../browser/ui/contextview/contextview.js";
import { h } from "../../browser/dom.js";

const environment = new JSDOM("<!doctype html><html><body><main></main><button id='anchor'>Anchor</button><button id='outside'>Outside</button></body></html>");
Object.defineProperties(globalThis, {
	window: { configurable: true, value: environment.window },
	document: { configurable: true, value: environment.window.document },
	Node: { configurable: true, value: environment.window.Node },
});
Object.defineProperties(environment.window, {
	innerWidth: { configurable: true, value: 800 },
	innerHeight: { configurable: true, value: 600 },
});
Object.defineProperty(environment.window.Element.prototype, "scrollTo", {
	configurable: true,
	value: () => {},
});

const { ContextView, ContextViewFocusRestore, ContextViewHideReason } = await import("../../browser/ui/contextview/contextview.js");

test("ContextView positions next to its anchor and flips within the viewport", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	anchor.getBoundingClientRect = () => rectangle(750, 550, 40, 30);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 200, 120);

	assert.equal(contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		gap: 4,
	}), true);

	assert.equal(contextView.element.style.left, "590px");
	assert.equal(contextView.element.style.top, "426px");
	assert.equal(contextView.element.classList.contains("ash-context-view-above"), true);
	assert.equal(contextView.element.classList.contains("ash-context-view-align-right"), true);
	contextView.dispose();
});

test("ContextView reports replacement and outside-pointer hide reasons exactly once", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	const outside = requiredElement<HTMLElement>("#outside");
	anchor.getBoundingClientRect = () => rectangle(20, 20, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];

	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});
	outside.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));
	outside.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));

	assert.deepEqual(reasons, [
		ContextViewHideReason.Replaced,
		ContextViewHideReason.OutsidePointer,
	]);
	assert.equal(contextView.visible, false);
	contextView.dispose();
});

test("ContextView restores focus after Escape closes the topmost view", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLButtonElement>("#anchor");
	anchor.getBoundingClientRect = () => rectangle(20, 20, 30, 20);
	anchor.focus();
	const content = h(environment.window.document, "button");
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];
	contextView.show({
		anchor,
		content,
		focusRestore: ContextViewFocusRestore.Previous,
		onHide: (reason) => reasons.push(reason),
	});
	content.focus();

	environment.window.document.dispatchEvent(new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));

	assert.deepEqual(reasons, [ContextViewHideReason.Escape]);
	assert.equal(environment.window.document.activeElement, anchor);
	contextView.dispose();
});

test("ContextView follows anchor and content size changes", () => {
	const observers: TestResizeObserver[] = [];
	class TestResizeObserver {
		readonly targets = new Set<Element>();

		constructor(private readonly listener: ResizeObserverCallback) {
			observers.push(this);
		}

		observe(target: Element): void {
			this.targets.add(target);
		}

		unobserve(target: Element): void {
			this.targets.delete(target);
		}

		disconnect(): void {
			this.targets.clear();
		}

		fire(): void {
			this.listener([], this as unknown as ResizeObserver);
		}
	}
	Object.defineProperty(environment.window, "ResizeObserver", {
		configurable: true,
		value: TestResizeObserver,
	});
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	let anchorTop = 40;
	let viewWidth = 100;
	anchor.getBoundingClientRect = () => rectangle(750, anchorTop, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, viewWidth, 80);
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
	});

	assert.equal(observers.length, 1);
	assert.deepEqual([...observers[0]!.targets], [contextView.element, anchor]);
	assert.equal(contextView.element.style.top, "60px");
	assert.equal(contextView.element.style.left, "680px");
	anchorTop = 120;
	viewWidth = 200;
	observers[0]!.fire();
	assert.equal(contextView.element.style.top, "140px");
	assert.equal(contextView.element.style.left, "580px");

	contextView.dispose();
	assert.equal(observers[0]!.targets.size, 0);
	Reflect.deleteProperty(environment.window, "ResizeObserver");
});

test("ContextView hides when a resized element anchor is no longer connected", () => {
	let listener: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			listener = callback;
		}

		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	Object.defineProperty(environment.window, "ResizeObserver", {
		configurable: true,
		value: TestResizeObserver,
	});
	const container = requiredElement<HTMLElement>("main");
	const anchor = h(environment.window.document, "button");
	container.append(anchor);
	anchor.getBoundingClientRect = () => rectangle(40, 40, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});

	anchor.remove();
	listener?.([], {} as ResizeObserver);

	assert.deepEqual(reasons, [ContextViewHideReason.AnchorRemoved]);
	contextView.dispose();
	Reflect.deleteProperty(environment.window, "ResizeObserver");
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

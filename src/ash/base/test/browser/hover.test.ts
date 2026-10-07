import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../browser/dom.js";
import type { CancellationToken } from '../../common/cancellation.js';

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
Object.defineProperty(environment.window.Element.prototype, 'scrollTo', {
	configurable: true,
	value(this: Element, left: number, top: number) { this.scrollLeft = left; this.scrollTop = top; },
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

test("Hover returns focus to its target when Escape dismisses focused content", () => {
	const container = requiredElement<HTMLElement>('main');
	const target = requiredElement<HTMLButtonElement>('#target');
	using contextView = new ContextView(container);
	const content = h(environment.window.document, 'div');
	const details = h(environment.window.document, 'span');
	const action = h(environment.window.document, 'button');
	content.append(details, action);
	using hover = new Hover({ target, content, contextViewProvider: contextView });
	hover.show();
	action.focus();
	details.textContent = 'Loaded details';
	assert.equal(environment.window.document.activeElement, action);
	assert.equal(contextView.element.querySelector('.ash-hover')?.textContent, 'Loaded details');
	action.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(hover.visible, false);
	assert.equal(environment.window.document.activeElement, target);
});

test('Hover traps Tab in interactive content and releases the listener when hidden', () => {
	const target = requiredElement<HTMLButtonElement>('#target');
	using contextView = new ContextView(requiredElement<HTMLElement>('main'));
	const content = h(environment.window.document, 'div');
	const first = h(environment.window.document, 'button', undefined, 'First');
	const disabled = h(environment.window.document, 'button', undefined, 'Disabled');
	disabled.disabled = true;
	const last = h(environment.window.document, 'button', undefined, 'Last');
	first.getClientRects = last.getClientRects = () => [rectangle(0, 0, 80, 24)] as unknown as DOMRectList;
	content.append(first, disabled, last);
	using hover = new Hover({ target, content, trapFocus: true, contextViewProvider: contextView });
	hover.show();
	last.focus();
	const tooltip = contextView.element.querySelector<HTMLElement>('.ash-hover')!;
	last.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
	assert.equal(environment.window.document.activeElement, first);
	first.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
	assert.equal(environment.window.document.activeElement, last);
	last.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(environment.window.document.activeElement, target);
	const tab = new environment.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
	tooltip.dispatchEvent(tab);
	assert.equal(tab.defaultPrevented, false);
});

test('Hover cancels content work on update, hide and disposal', () => {
	const target = requiredElement<HTMLButtonElement>('#target');
	using contextView = new ContextView(requiredElement<HTMLElement>('main'));
	const tokens: CancellationToken[] = [];
	using hover = new Hover({
		target,
		contextViewProvider: contextView,
		content: token => {
			tokens.push(token);
			return 'Commit details';
		},
	});
	hover.show();
	assert.equal(tokens[0]!.isCancellationRequested, false);
	hover.update('Updated content');
	assert.equal(tokens[0]!.isCancellationRequested, true);
	hover.update(token => { tokens.push(token); return 'New details'; });
	hover.hide();
	assert.equal(tokens[1]!.isCancellationRequested, true);
	hover.show();
	assert.equal(tokens[2]!.isCancellationRequested, false);
	let hidden = 0;
	using listener = hover.onDidHide(() => hidden++);
	hover.dispose();
	assert.equal(tokens[2]!.isCancellationRequested, true);
	assert.equal(hidden, 1);
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

test("Hover delays keyboard focus and ignores focus restored from dismissed overlays", async () => {
	const container = requiredElement<HTMLElement>("main");
	const target = requiredElement<HTMLButtonElement>("#target");
	const previous = h(environment.window.document, "button");
	const dismissedHover = h(environment.window.document, "div");
	dismissedHover.className = "ash-hover";
	const hoverAction = h(environment.window.document, "button");
	dismissedHover.append(hoverAction);
	container.append(previous, dismissedHover);
	const contextView = new ContextView(container);
	const hover = new Hover({
		target,
		content: "Managed title",
		delayMs: 1,
		contextViewProvider: contextView,
	});

	target.dispatchEvent(new environment.window.FocusEvent("focusin", { bubbles: true }));
	assert.equal(hover.visible, false);
	target.dispatchEvent(new environment.window.FocusEvent("focusin", { bubbles: true, relatedTarget: hoverAction }));
	assert.equal(hover.visible, false);
	target.dispatchEvent(new environment.window.FocusEvent("focusin", { bubbles: true, relatedTarget: previous }));
	assert.equal(hover.visible, false);
	await nextTimer();
	assert.equal(hover.visible, true);

	hover.dispose();
	contextView.dispose();
	previous.remove();
	dismissedHover.remove();
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

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

const { Sash, SashSettingsBinding, SashState } = await import("../../browser/ui/sash/sash.js");

test("Sash settings are scoped to a subtree and clean up their projection", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	const sash = h(dom.window.document, "div");
	sash.className = "ash-sash";
	root.append(sash);

	{
		using binding = new SashSettingsBinding(root);
		binding.update({
			dragAreaSize: 12,
			hoverFeedbackSize: 6,
			hoverDelay: 150,
		});
		assert.equal(
			dom.window.getComputedStyle(sash)
				.getPropertyValue("--ash-sash-drag-area-size"),
			"12px",
		);
		assert.equal(
			dom.window.getComputedStyle(sash)
				.getPropertyValue("--ash-sash-hover-feedback-size"),
			"6px",
		);
		assert.equal(
			dom.window.getComputedStyle(sash)
				.getPropertyValue("--ash-sash-hover-delay"),
			"150ms",
		);
	}

	assert.equal(root.className, "");
	assert.equal(dom.window.document.head.querySelector("style"), null);
	dom.window.close();
});

test("Sash settings reject invalid dimensions and delays", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	using binding = new SashSettingsBinding(root);

	assert.throws(
		() => binding.update({
			dragAreaSize: 0,
			hoverFeedbackSize: 1,
			hoverDelay: 0,
		}),
		/drag area size/,
	);
	assert.throws(
		() => binding.update({
			dragAreaSize: 4,
			hoverFeedbackSize: 1,
			hoverDelay: -1,
		}),
		/hover delay/,
	);
	dom.window.close();
});

test("Sash applies configured hover feedback and active drag state", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	using binding = new SashSettingsBinding(root);
	binding.update({
		dragAreaSize: 4,
		hoverFeedbackSize: 4,
		hoverDelay: 0,
	});
	using sash = new Sash(dom.window.document.body, "vertical");
	root.append(sash.element);

	sash.element.dispatchEvent(new dom.window.MouseEvent("pointerenter"));
	assert.equal(sash.element.classList.contains("ash-sash-hover"), true);
	sash.element.dispatchEvent(new dom.window.MouseEvent("pointerleave"));
	assert.equal(sash.element.classList.contains("ash-sash-hover"), false);

	sash.element.dispatchEvent(new dom.window.MouseEvent("pointerdown", {
		bubbles: true,
		button: 0,
	}));
	assert.equal(sash.element.classList.contains("ash-sash-active"), true);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", {
		bubbles: true,
		button: 0,
	}));
	assert.equal(sash.element.classList.contains("ash-sash-active"), false);
	dom.window.close();
});

test("Sash projects directional and disabled interaction states", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using sash = new Sash(dom.window.document.body, "vertical");
	dom.window.document.body.append(sash.element);
	let starts = 0;
	sash.onDidStart(() => starts += 1);

	sash.state = SashState.AtMinimum;
	assert.equal(sash.element.classList.contains("ash-sash-minimum"), true);
	assert.equal(sash.element.getAttribute("aria-disabled"), "false");
	assert.equal(sash.element.tabIndex, 0);

	sash.state = SashState.Disabled;
	sash.element.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
	sash.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
	assert.equal(starts, 0);
	assert.equal(sash.element.classList.contains("ash-sash-disabled"), true);
	assert.equal(sash.element.getAttribute("aria-disabled"), "true");
	assert.equal(sash.element.tabIndex, -1);

	dom.window.close();
});

test("Sash corner handles drag both orthogonal separators", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using horizontal = new Sash(dom.window.document.body, "horizontal");
	using vertical = new Sash(dom.window.document.body, "vertical");
	dom.window.document.body.append(horizontal.element, vertical.element);
	const horizontalDeltas: number[] = [];
	const verticalDeltas: number[] = [];
	let resets = 0;
	horizontal.onDidChange((event) => horizontalDeltas.push(event.delta));
	vertical.onDidChange((event) => verticalDeltas.push(event.delta));
	horizontal.onDidReset(() => resets += 1);
	vertical.onDidReset(() => resets += 1);
	horizontal.orthogonalStartSash = vertical;
	const handle = horizontal.element.querySelector<HTMLElement>(".ash-sash-orthogonal-handle-start");
	assert.ok(handle);

	handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 60 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 60 }));
	assert.deepEqual(horizontalDeltas, [40]);
	assert.deepEqual(verticalDeltas, [30]);

	handle.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
	assert.equal(resets, 2);
	vertical.state = SashState.Disabled;
	assert.equal(horizontal.element.querySelector(".ash-sash-orthogonal-handle-start"), null);
	using sameOrientation = new Sash(dom.window.document.body, "horizontal");
	assert.throws(() => horizontal.orthogonalEndSash = sameOrientation, /different orientations/);

	dom.window.close();
});

test("Sash forwards drag, hover, and reset to a linked Sash", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	using binding = new SashSettingsBinding(root);
	binding.update({ dragAreaSize: 4, hoverFeedbackSize: 4, hoverDelay: 0 });
	using first = new Sash(dom.window.document.body, "vertical");
	using second = new Sash(dom.window.document.body, "vertical");
	root.append(first.element, second.element);
	first.linkedSash = second;
	second.linkedSash = first;
	const firstDeltas: number[] = [];
	const secondDeltas: number[] = [];
	let resets = 0;
	first.onDidChange((event) => firstDeltas.push(event.delta));
	second.onDidChange((event) => secondDeltas.push(event.delta));
	first.onDidReset(() => resets += 1);
	second.onDidReset(() => resets += 1);
	let firstPointerCaptures = 0;
	let secondPointerCaptures = 0;
	first.element.setPointerCapture = () => firstPointerCaptures += 1;
	second.element.setPointerCapture = () => secondPointerCaptures += 1;

	first.element.dispatchEvent(new dom.window.MouseEvent("pointerenter"));
	assert.equal(first.element.classList.contains("ash-sash-hover"), true);
	assert.equal(second.element.classList.contains("ash-sash-hover"), true);
	first.element.dispatchEvent(new dom.window.MouseEvent("pointerleave"));
	assert.equal(second.element.classList.contains("ash-sash-hover"), false);
	const pointerDown = new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10 });
	Object.defineProperty(pointerDown, "pointerId", { value: 1 });
	first.element.dispatchEvent(pointerDown);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 35 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 35 }));
	assert.deepEqual(firstDeltas, [25]);
	assert.deepEqual(secondDeltas, [25]);
	assert.equal(firstPointerCaptures, 1);
	assert.equal(secondPointerCaptures, 0);
	first.element.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
	assert.equal(resets, 2);

	using horizontal = new Sash(dom.window.document.body, "horizontal");
	assert.throws(() => first.linkedSash = horizontal, /same orientation/);
	dom.window.close();
});

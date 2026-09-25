import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../browser/dom.js";

test("SelectBox owns its unfold trigger and trailing selected check inside a themed ContextView", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
	Object.defineProperties(globalThis, {
		window: { configurable: true, value: dom.window },
		document: { configurable: true, value: dom.window.document },
		Node: { configurable: true, value: dom.window.Node },
		HTMLElement: { configurable: true, value: dom.window.HTMLElement },
	});
	Object.defineProperty(dom.window.Element.prototype, "scrollIntoView", {
		configurable: true,
		value(): void {},
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value(): void {},
	});
	const [{ ContextView }, { appendIcon }, { SelectBox }, { Lxicon }] = await Promise.all([
		import("../../browser/ui/contextview/contextview.js"),
		import("../../browser/ui/lxicons/lxicon.js"),
		import("../../browser/ui/selectbox/selectbox.js"),
		import("../../common/lxicons.js"),
	]);
	const host = dom.window.document.querySelector<HTMLElement>("main")!;
	const contextView = new ContextView(host);
	const selectBox = new SelectBox(dom.window.document.body, {
		options: [
			{ value: "auto", label: "Auto" },
			{ value: "on", label: "On" },
			{ value: "off", label: "Off" },
		],
		selectedValue: "auto",
		ariaLabel: "Screen reader optimization",
		contextViewProvider: contextView,
	});
	host.append(selectBox.element);

	const button = selectBox.element.querySelector<HTMLButtonElement>(".ash-select-box-button")!;
	button.getBoundingClientRect = () => ({ width: 192 } as DOMRect);
	const indicator = selectBox.element.querySelector<HTMLElement>(".ash-dropdown-indicator")!;
	const expectedIndicator = h(dom.window.document, "span");
	appendIcon(Lxicon.unfold, expectedIndicator);
	assert.equal(indicator.innerHTML, expectedIndicator.innerHTML);

	selectBox.show();
	assert.equal(contextView.element.parentElement, host);
	assert.equal(contextView.element.classList.contains("ash-context-view-default"), true);
	const list = contextView.element.querySelector<HTMLElement>(".ash-select-box-list")!;
	assert.ok(list);
	assert.equal(list.style.getPropertyValue("--dropdown-trigger-width"), "192px");
	const selected = list.querySelector<HTMLElement>(".ash-select-box-option-selected")!;
	const check = selected.querySelector<HTMLElement>(":scope > .ash-select-box-option-check")!;
	const expectedCheck = h(dom.window.document, "span");
	appendIcon(Lxicon.check, expectedCheck);
	assert.equal(selected.lastElementChild, check);
	assert.equal(check.innerHTML, expectedCheck.innerHTML);
	assert.equal(selected.getAttribute("aria-selected"), "true");

	selectBox.dispose();
	contextView.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "document");
	Reflect.deleteProperty(globalThis, "Node");
	Reflect.deleteProperty(globalThis, "HTMLElement");
});

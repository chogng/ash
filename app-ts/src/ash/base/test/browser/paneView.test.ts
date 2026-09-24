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
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { PaneView } = await import("../../browser/ui/splitview/paneView.js");

test("PaneView owns titled collapse semantics and its stable visual state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const pane = new PaneView(dom.window.document.body, {
		id: "test-pane",
		title: "Test Pane",
		collapsed: true,
	});
	dom.window.document.body.append(pane.element);

	const button = pane.element.querySelector<HTMLButtonElement>(
		".ash-pane-view-header-button",
	);
	const content = pane.element.querySelector<HTMLElement>(
		".ash-pane-view-content",
	);
	assert.ok(button);
	assert.ok(content);
	assert.equal(pane.element.classList.contains("collapsed"), true);
	assert.equal(content.classList.contains("collapsed"), true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.equal(content.hidden, true);

	button.click();

	assert.equal(pane.isCollapsed(), false);
	assert.equal(pane.element.classList.contains("collapsed"), false);
	assert.equal(content.classList.contains("collapsed"), false);
	assert.equal(button.classList.contains("expanded"), true);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	assert.equal(content.hidden, false);

	pane.setTitle("Renamed");
	assert.equal(
		pane.element.querySelector(".ash-pane-view-header-title")?.textContent,
		"Renamed",
	);

	pane.dispose();
	dom.window.close();
});

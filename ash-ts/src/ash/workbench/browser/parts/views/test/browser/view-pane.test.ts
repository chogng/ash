import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IViewPaneOptions } from "../../../../../../workbench/browser/parts/views/viewPane.js";

test("ViewPane title chevron tracks collapsed state", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(dom);
	try {
		const { ViewPane } = await import("../../../../../../workbench/browser/parts/views/viewPane.js");
		class TestViewPane extends ViewPane {
			constructor(container: HTMLElement, options: IViewPaneOptions) {
				super(container, options);
			}
		}
		using pane = new TestViewPane(dom.window.document.body, {
			id: "test.pane",
			title: "Test Pane",
			collapsed: true,
		});

		const visibility: boolean[] = [];
		using listener = pane.onDidChangeBodyVisibility(value => visibility.push(value));
		assert.equal(pane.isVisible(), false);
		assert.equal(pane.isBodyVisible(), false);
		pane.setVisible(true);
		assert.deepEqual(visibility, []);

		const title = pane.element.querySelector(".ash-pane-view-header-title");
		const button = pane.element.querySelector<HTMLButtonElement>(".ash-pane-view-header-button");
		const content = pane.element.querySelector<HTMLElement>(".ash-pane-view-content");
		assert.equal(title?.textContent, "Test Pane");
		assert.equal(button?.getAttribute("aria-expanded"), "false");
		assert.equal(button?.getAttribute("aria-controls"), content?.id);
		assert.equal(button?.classList.contains("expanded"), false);
		assert.equal(pane.element.classList.contains("collapsed"), true);
		assert.equal(content?.hidden, true);
		assert.equal(button?.querySelectorAll(".ash-icon").length, 2);

		button?.click();
		assert.equal(pane.isCollapsed(), false);
		assert.equal(button?.getAttribute("aria-expanded"), "true");
		assert.equal(button?.classList.contains("expanded"), true);
		assert.equal(pane.element.classList.contains("collapsed"), false);
		assert.equal(content?.hidden, false);

		assert.equal(pane.isBodyVisible(), true);
		assert.deepEqual(visibility, [true]);
		assert.equal(pane.setExpanded(true), false);
		pane.setVisible(false);
		assert.equal(pane.isBodyVisible(), false);
		assert.equal(pane.setExpanded(false), true);
		assert.equal(pane.setExpanded(true), true);
		assert.equal(pane.isBodyVisible(), false);
		pane.setVisible(true);
		assert.deepEqual(visibility, [true, false, false, true, true]);

		pane.setTitle("Renamed Pane");
		assert.equal(title?.textContent, "Renamed Pane");
		assert.equal(button?.querySelectorAll(".ash-icon").length, 2);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		dom.window.close();
	}
});

function installDomGlobals(dom: JSDOM): readonly string[] {
	const globals = {
		window: dom.window,
		document: dom.window.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		MouseEvent: dom.window.MouseEvent,
		navigator: dom.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
	return Object.keys(globals);
}

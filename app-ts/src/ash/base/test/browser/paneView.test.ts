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

const { Pane, PaneView } = await import("../../browser/ui/splitview/paneview.js");

test("Pane owns titled collapse semantics and its stable visual state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const pane = new Pane(dom.window.document.body, {
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

test("PaneView restores expanded sizes, retains content across moves and detaches removed listeners", () => {
	const document = browserEnvironment.window.document;
	using view = new PaneView(document.body);
	using first = new Pane(document.body, { id: "first", title: "First" });
	using second = new Pane(document.body, { id: "second", title: "Second", collapsed: true });
	const input = document.createElement("input");
	input.value = "draft";
	second.element.querySelector(".ash-pane-view-content")!.append(input);
	view.addPane(first, 200);
	view.addPane(second, 200);
	view.layout(500, 280);
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(second)], [472, 28]);
	second.setCollapsed(false);
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(second)], [300, 200]);
	view.resizePane(second, 270);
	input.focus();
	second.setCollapsed(true);
	assert.equal(document.activeElement, second.element.querySelector(".ash-pane-view-header-button"));
	second.setCollapsed(false);
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(second)], [230, 270]);
	input.focus();
	view.movePane(second, first);
	assert.deepEqual([...view.element.querySelectorAll(".ash-pane-view")].map(element => (element as HTMLElement).dataset.paneViewId), ["second", "first"]);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "draft");
	view.removePane(second);
	second.setCollapsed(true);
	second.setCollapsed(false);
	assert.equal(view.getPaneSize(first), 500);
	assert.equal(view.getPaneSize(second), -1);
	assert.equal(second.element.isConnected, false);
	view.addPane(second, 270);
	assert.equal(input.value, "draft");
	assert.equal(view.getPaneSize(second), 270);
});

test("PaneView keeps minimum heights scrollable and supports header keyboard navigation", () => {
	const document = browserEnvironment.window.document;
	using view = new PaneView(document.body);
	using first = new Pane(document.body, { id: "first", title: "First" });
	using second = new Pane(document.body, { id: "second", title: "Second" });
	view.addPane(first, 100);
	view.addPane(second, 100);
	view.layout(60, 280);
	assert.equal(view.element.firstElementChild?.getAttribute("style"), "height: 152px;");
	const firstHeader = first.element.querySelector<HTMLButtonElement>(".ash-pane-view-header-button")!;
	const secondHeader = second.element.querySelector<HTMLButtonElement>(".ash-pane-view-header-button")!;
	firstHeader.focus();
	firstHeader.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	assert.equal(document.activeElement, secondHeader);
	secondHeader.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
	assert.equal(second.isCollapsed(), true);
	secondHeader.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
	assert.equal(document.activeElement, firstHeader);
	first.setCollapsed(true);
	assert.equal(view.element.firstElementChild?.getAttribute("style"), "height: 60px;");
	first.setCollapsed(false);
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(second)], [76, 28]);
});

test("PaneView double-click resets expanded panes across a collapsed pane", () => {
	const document = browserEnvironment.window.document;
	using view = new PaneView(document.body);
	using first = new Pane(document.body, { id: "first", title: "First" });
	using middle = new Pane(document.body, { id: "middle", title: "Middle", collapsed: true });
	using last = new Pane(document.body, { id: "last", title: "Last" });
	view.addPane(first, 212);
	view.addPane(middle, 200);
	view.addPane(last, 260);
	view.layout(500, 280);
	view.element.querySelectorAll(".ash-sash")[1]!.dispatchEvent(new browserEnvironment.window.MouseEvent("dblclick", { bubbles: true }));
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(middle), view.getPaneSize(last)], [236, 28, 236]);
});

test("PaneView lays out once per toggle and retains its resize boundary", () => {
	class CountingPane extends Pane {
		public layouts = 0;
		protected override layoutBody(): void {
			this.layouts += 1;
		}
	}
	const document = browserEnvironment.window.document;
	using view = new PaneView(document.body);
	using first = new CountingPane(document.body, { id: "count-first", title: "First" });
	using second = new Pane(document.body, { id: "count-second", title: "Second" });
	view.addPane(first, 200);
	view.addPane(second, 200);
	view.layout(400, 280);
	const sash = view.element.querySelector<HTMLElement>(".ash-sash")!;
	const layouts = first.layouts;
	for (let index = 0; index < 10; index += 1) {
		second.setCollapsed(true);
		assert.equal(sash.getAttribute("aria-disabled"), "true");
		second.setCollapsed(false);
	}
	assert.deepEqual({
		layouts: first.layouts - layouts,
		sash: view.element.querySelector(".ash-sash"),
		sashCount: view.element.querySelectorAll(".ash-sash").length,
		resizable: sash.getAttribute("aria-disabled"),
		sizes: [view.getPaneSize(first), view.getPaneSize(second)],
	}, {
		layouts: 20,
		sash,
		sashCount: 1,
		resizable: "false",
		sizes: [200, 200],
	});
	sash.focus();
	sash.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
	assert.deepEqual([view.getPaneSize(first), view.getPaneSize(second)], [190, 210]);
	assert.equal(document.activeElement, sash);
});

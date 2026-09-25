import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { TAB_CLOSE_ACTION_ID, TabList, type TabListItem } from "../../browser/ui/tablist/tabList.js";
import type { IAction } from "../../common/actions.js";
import { registerLxicon } from "../../common/lxiconsUtil.js";

const customCloseIcon = registerLxicon("tablist-test-close", () => '<svg viewBox="0 0 16 16" data-test-icon="custom-close"><path d="M2 2h12v12H2z"/></svg>');

test("TabList owns manual selection semantics and roving focus", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const activations: string[] = [];
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Documents",
		onActivate: (value: string) => activations.push(value),
	});
	const tabs = [
		tab("first"),
		tab("second"),
	];
	tabList.setTabs(tabs, "first");
	dom.window.document.body.append(tabList.element);
	const elements =
		tabList.element.querySelectorAll<HTMLButtonElement>("[role='tab']");
	const tablist = tabList.element.querySelector<HTMLElement>(
		"[role='tablist']",
	);
	assert.equal(tabList.element.dataset.scrollDirection, "horizontal");
	assert.equal(tabList.element.classList.contains("ash-tab-list-flush"), true);
	assert.equal(
		tabList.element.querySelector(
			".ash-scrollbar-track-vertical",
		)?.hasAttribute("hidden"),
		true,
	);
	const first = elements[0];
	const second = elements[1];
	assert.ok(first);
	assert.ok(second);
	assert.equal(tablist?.getAttribute("role"), "tablist");
	assert.equal(tablist?.getAttribute("aria-label"), "Documents");
	assert.deepEqual(
		[...(tablist?.children ?? [])].map((container) => container.getAttribute("role")),
		["presentation", "presentation"],
	);
	assert.deepEqual(
		[...(tablist?.children ?? [])].map((container) => container.firstElementChild?.getAttribute("role")),
		["tab", "tab"],
	);
	assert.deepEqual(
		[...elements].map((element) => element.getAttribute("aria-selected")),
		["true", "false"],
	);
	assert.deepEqual(
		[...tabList.element.querySelectorAll(".ash-tab")].map((element) => element.classList.contains("checked")),
		[true, false],
	);
	assert.deepEqual([...elements].map((element) => element.tabIndex), [0, -1]);
	assert.equal(first.getAttribute("aria-controls"), "first-panel");

	first.focus();
	first.dispatchEvent(keyboardEvent(dom.window, "ArrowRight"));
	assert.equal(dom.window.document.activeElement, second);
	assert.equal(second.getAttribute("aria-selected"), "false");
	assert.deepEqual(activations, []);
	second.click();
	assert.deepEqual(activations, ["second"]);

	tabList.setTabs(tabs, "second");
	assert.deepEqual(
		[...tabList.element.querySelectorAll<HTMLElement>("[role='tab']")]
			.map((element) => element.getAttribute("aria-selected")),
		["false", "true"],
	);
	assert.deepEqual(
		[...tabList.element.querySelectorAll(".ash-tab")].map((element) => element.classList.contains("checked")),
		[false, true],
	);

	tabList.dispose();
	dom.window.close();
});

test("TabList exposes its ActionBar edge treatment as a presentation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tabList = new TabList<string>(dom.window.document.body, {
		ariaLabel: "Inset tabs",
		presentation: "inset",
		onActivate: () => undefined,
	});
	assert.equal(tabList.element.classList.contains("ash-tab-list-inset"), true);
	tabList.setPresentation("flush");
	assert.equal(tabList.element.classList.contains("ash-tab-list-inset"), false);
	assert.equal(tabList.element.classList.contains("ash-tab-list-flush"), true);
	tabList.setPresentation("inset");
	assert.equal(tabList.element.classList.contains("ash-tab-list-inset"), true);
	assert.equal(tabList.element.classList.contains("ash-tab-list-flush"), false);
	tabList.dispose();
	dom.window.close();
});

test("TabList reveals the selected tab when horizontal content overflows", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Overflowing tabs",
		onActivate: () => undefined,
	});
	dom.window.document.body.append(tabList.element);
	const viewport = tabList.element.querySelector<HTMLElement>(
		".ash-scrollbar-viewport",
	);
	assert.ok(viewport);
	installMetrics(viewport, {
		width: 100,
		height: 24,
		scrollWidth: 300,
		scrollHeight: 24,
	});
	viewport.getBoundingClientRect = () => rect(0, 0, 100, 24);
	const originalGetBoundingClientRect =
		dom.window.HTMLElement.prototype.getBoundingClientRect;
	dom.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
		if (this.classList.contains("ash-tab")) return rect(150, 0, 200, 24);
		return originalGetBoundingClientRect.call(this);
	};

	tabList.setTabs([tab("first"), tab("second")], "second");

	assert.equal(viewport.scrollLeft, 100);
	tabList.dispose();
	dom.window.close();
});

test("TabList can opt its items into native drag-source presentation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Draggable tabs",
		draggable: true,
		onActivate: () => undefined,
	});
	tabList.setTabs([tab("first")], "first");
	const item = tabList.element.querySelector<HTMLElement>(".ash-tab");
	assert.ok(item);
	assert.equal(item.draggable, true);
	assert.equal(item.classList.contains("ash-dnd-draggable"), true);

	tabList.dispose();
	dom.window.close();
});

test("TabList forwards ActionBar drag positions using tab values", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const drops: Array<{ target: string | undefined; position: string }> = [];
	let dragging = false;
	const tabList = new TabList<string>(dom.window.document.body, {
		ariaLabel: "Reorderable tabs",
		draggable: true,
		dragAndDrop: {
			canDrop: () => dragging,
			onDragStart: () => {
				dragging = true;
			},
			onDrop: (target, position) => drops.push({ target, position }),
			onDragEnd: () => {
				dragging = false;
			},
		},
		onActivate: () => undefined,
	});
	tabList.setTabs([tab("first"), tab("second")], "first");
	dom.window.document.body.append(tabList.element);
	const [first, second] = tabList.element.querySelectorAll<HTMLElement>(".ash-tab");
	assert.ok(first);
	assert.ok(second);
	Object.defineProperty(second, "getBoundingClientRect", {
		value: () => ({ left: 100, width: 100 }),
	});

	first.dispatchEvent(dragEvent(dom.window, "dragstart"));
	second.dispatchEvent(dragEvent(dom.window, "dragover", 175));
	second.dispatchEvent(dragEvent(dom.window, "drop", 175));

	assert.deepEqual(drops, [{ target: "second", position: "after" }]);
	assert.equal(dragging, false);
	tabList.dispose();
	dom.window.close();
});

test("TabList renders IconLabel content, custom actions, and its standard close action", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const closed: string[] = [];
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Editors",
		onActivate: () => undefined,
		onClose: (value: string) => closed.push(value),
		closeActionIcon: customCloseIcon,
	});
	const pin: IAction = {
		id: "pin",
		label: "Pin first",
		tooltip: "Pin first",
		enabled: true,
		run: () => undefined,
	};
	tabList.setTabs([{
		...tab("first"),
		actions: {
			ariaLabel: "First tab actions",
			items: [pin],
		},
	}], "first");
	dom.window.document.body.append(tabList.element);
	const selected = tabList.element.querySelector<HTMLButtonElement>(
		"[role='tab']",
	);
	const closeButton = tabList.element.querySelector<HTMLButtonElement>(
		".ash-tab-close-action button",
	);
	assert.ok(selected);
	assert.ok(closeButton);
	assert.equal(
		selected.querySelector(".ash-icon-label-text")?.textContent,
		"first",
	);
	assert.equal(selected.getAttribute("aria-keyshortcuts"), "Delete");
	assert.equal(
		tabList.element.querySelector(".ash-tab-actions")?.getAttribute("role"),
		"toolbar",
	);
	assert.equal(
		tabList.element.querySelector(".ash-tab-actions")
			?.getAttribute("aria-label"),
		"First tab actions",
	);
	assert.deepEqual(
		[...tabList.element.querySelectorAll<HTMLElement>(".ash-tab-actions [data-action-id]")]
			.map((item) => item.dataset.actionId),
		["pin", TAB_CLOSE_ACTION_ID],
	);
	assert.equal(closeButton.title, "Close first");
	assert.equal(closeButton.closest(".ash-action-view-item")?.getAttribute("data-action-id"), TAB_CLOSE_ACTION_ID);
	assert.equal(closeButton.querySelector("svg.ash-icon")?.getAttribute("data-test-icon"), "custom-close");

	selected.dispatchEvent(keyboardEvent(dom.window, "Delete"));
	closeButton.click();
	assert.deepEqual(closed, ["first", "first"]);

	tabList.dispose();
	dom.window.close();
});

test("TabList supports vertical ActionBar navigation and scrolling", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Terminal instances",
		orientation: "vertical",
		onActivate: () => undefined,
	});
	tabList.setTabs([{ ...tab("first"), state: "running" }], "first");
	dom.window.document.body.append(tabList.element);
	const actionBar = tabList.element.querySelector<HTMLElement>("[role='tablist']");
	assert.equal(tabList.element.dataset.scrollDirection, "vertical");
	assert.equal(actionBar?.getAttribute("aria-orientation"), "vertical");
	assert.equal(actionBar?.classList.contains("vertical"), true);
	assert.equal(actionBar?.querySelector(".ash-tab.checked") !== null, true);
	assert.equal(actionBar?.querySelector<HTMLElement>(".ash-tab")?.dataset.state, "running");

	tabList.dispose();
	dom.window.close();
});

test("TabList rejects ambiguous item and selection identities", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tabList = new TabList(dom.window.document.body, {
		ariaLabel: "Tabs",
		onActivate: () => undefined,
	});
	assert.throws(
		() => tabList.setTabs([tab("same"), tab("same")], "same"),
		/Duplicate TabList item ID/,
	);
	assert.throws(
		() => tabList.setTabs([tab("first")], "missing"),
		/Selected TabList item is not available/,
	);

	tabList.dispose();
	dom.window.close();
});

function tab(id: string): TabListItem<string> {
	return {
		id,
		value: id,
		label: id,
		tabId: `${id}-tab`,
		panelId: `${id}-panel`,
	};
}

function keyboardEvent(
	targetWindow: { readonly KeyboardEvent: typeof KeyboardEvent },
	key: string,
): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
	});
}

function dragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	return event;
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

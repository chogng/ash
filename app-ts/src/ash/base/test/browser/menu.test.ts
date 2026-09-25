import assert from "node:assert/strict";
import { mock } from "node:test";
import { test } from "mocha";
import { JSDOM } from "jsdom";

test("Menu renders submenu actions with the shared SVG indicator", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu }] = await Promise.all([
		import("../../common/actions.js"),
		import("../../browser/ui/menu/menu.js"),
	]);
	const menu = new Menu(dom.window.document.body, {
		actions: [new SubmenuAction("test.submenu", "More", [])],
	});
	dom.window.document.body.append(menu.element);

	const menuItem = menu.element.querySelector('[role="menuitem"]');
	assert.ok(menuItem instanceof dom.window.HTMLButtonElement);
	assert.equal(menuItem.getAttribute("aria-haspopup"), "menu");
	assert.equal(menuItem.getAttribute("aria-expanded"), "false");
	const indicator = menuItem.querySelector(".ash-submenu-indicator");
	assert.ok(indicator instanceof dom.window.HTMLSpanElement);
	const icon = indicator.querySelector(":scope > svg.ash-icon");
	assert.ok(icon instanceof dom.window.SVGElement);
	assert.equal(icon.getAttribute("aria-hidden"), "true");
	assert.equal(indicator.textContent, "");

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

test("Menu renders action badges as trailing metadata", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: dom.window.Node,
	});
	const { Menu } = await import("../../browser/ui/menu/menu.js");
	const menu = new Menu(dom.window.document.body, {
		actions: [{
			id: "test.badge",
			label: "Model",
			tooltip: "Model",
			badge: "Subscription",
			enabled: true,
			run(): void {},
		}],
	});

	assert.equal(menu.element.querySelector(".ash-menu-badge")?.textContent, "Subscription");

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

test("Menu projects one focused item for keyboard and pointer navigation", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: dom.window.Node,
	});
	const { Menu } = await import("../../browser/ui/menu/menu.js");
	const menu = new Menu(dom.window.document.body, {
		actions: ["first", "second", "third"].map((id) => ({
			id,
			label: id,
			tooltip: id,
			enabled: true,
			run(): void {},
		})),
	});
	dom.window.document.body.append(menu.element);
	const items = [...menu.element.querySelectorAll<HTMLElement>(
		":scope > .ash-action-view-item",
	)];
	const buttons = items.map((item) =>
		item.querySelector<HTMLButtonElement>(":scope > .ash-button")!
	);
	for (const button of buttons) {
		button.getClientRects = () => [{}] as unknown as DOMRectList;
	}
	Object.defineProperty(dom.window.Element.prototype, "scrollTo", {
		configurable: true,
		value(): void {},
	});

	menu.focusFirst();
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.deepEqual(items.map((item) => item.classList.contains("focused")), [
		true,
		false,
		false,
	]);

	buttons[1]!.dispatchEvent(new dom.window.MouseEvent("mouseover", {
		bubbles: true,
		relatedTarget: buttons[0],
	}));
	assert.equal(dom.window.document.activeElement, buttons[1]);
	assert.deepEqual(items.map((item) => item.classList.contains("focused")), [
		false,
		true,
		false,
	]);

	buttons[1]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		key: "ArrowDown",
	}));
	assert.equal(dom.window.document.activeElement, buttons[2]);
	assert.deepEqual(items.map((item) => item.classList.contains("focused")), [
		false,
		false,
		true,
	]);

	menu.element.dispatchEvent(new dom.window.MouseEvent("mouseout", {
		bubbles: true,
		relatedTarget: dom.window.document.body,
	}));
	assert.equal(items.some((item) => item.classList.contains("focused")), false);

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

test("Menu delays pointer expansion and switches the expanded submenu", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	mock.timers.enable({ apis: ["setTimeout"] });
	Object.defineProperty(dom.window.Element.prototype, "scrollTo", {
		configurable: true,
		value(): void {},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu }] = await Promise.all([
		import("../../common/actions.js"),
		import("../../browser/ui/menu/menu.js"),
	]);
	const menu = new Menu(dom.window.document.body, {
		actions: [
			new SubmenuAction("first", "First", [{
				id: "first.child",
				label: "First child",
				tooltip: "First child",
				enabled: true,
				run(): void {},
			}]),
			new SubmenuAction("second", "Second", [{
				id: "second.child",
				label: "Second child",
				tooltip: "Second child",
				enabled: true,
				run(): void {},
			}]),
		],
	});
	const first = menu.element.querySelector<HTMLButtonElement>('[data-action-id="first"] button')!;
	const second = menu.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button')!;
	const firstContainer = first.parentElement!;
	const movePointer = (button: HTMLButtonElement, previous: Element): void => {
		button.dispatchEvent(new dom.window.MouseEvent("mouseover", {
			bubbles: true,
			relatedTarget: previous,
		}));
		const movement = new dom.window.MouseEvent("mousemove", { bubbles: true });
		Object.defineProperty(movement, "movementX", { value: 1 });
		button.dispatchEvent(movement);
	};

	try {
		first.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		mock.timers.tick(250);
		assert.equal(first.getAttribute("aria-expanded"), "false");

		movePointer(first, dom.window.document.body);
		firstContainer.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
		mock.timers.tick(250);
		assert.equal(first.getAttribute("aria-expanded"), "false");

		movePointer(first, dom.window.document.body);
		mock.timers.tick(249);
		assert.equal(first.getAttribute("aria-expanded"), "false");
		mock.timers.tick(1);
		assert.equal(first.getAttribute("aria-expanded"), "true");

		firstContainer.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
		movePointer(second, first);
		mock.timers.tick(249);
		assert.equal(first.getAttribute("aria-expanded"), "true");
		assert.equal(second.getAttribute("aria-expanded"), "false");
		mock.timers.tick(1);
		assert.equal(first.getAttribute("aria-expanded"), "false");
		assert.equal(second.getAttribute("aria-expanded"), "true");
		assert.equal(dom.window.document.querySelectorAll('.ash-context-view-menu:not([hidden])').length, 1);
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "Node");
		mock.timers.reset();
	}
});

test("Menu preserves submenu focus and closes after focus leaves or the parent scrolls", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	mock.timers.enable({ apis: ["setTimeout"] });
	Object.defineProperty(dom.window.Element.prototype, "scrollTo", {
		configurable: true,
		value(): void {},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu }] = await Promise.all([
		import("../../common/actions.js"),
		import("../../browser/ui/menu/menu.js"),
	]);
	const menu = new Menu(dom.window.document.body, {
		actions: [
			new SubmenuAction("submenu", "Submenu", [{
				id: "child",
				label: "Child",
				tooltip: "Child",
				enabled: true,
				run(): void {},
			}]),
			{
				id: "leaf",
				label: "Leaf",
				tooltip: "Leaf",
				enabled: true,
				run(): void {},
			},
		],
	});
	const trigger = menu.element.querySelector<HTMLButtonElement>('[data-action-id="submenu"] button')!;
	const leaf = menu.element.querySelector<HTMLButtonElement>('[data-action-id="leaf"] button')!;
	const movement = new dom.window.MouseEvent("mousemove", { bubbles: true });
	Object.defineProperty(movement, "movementX", { value: 1 });

	try {
		trigger.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		trigger.dispatchEvent(movement);
		mock.timers.tick(250);
		assert.equal(trigger.getAttribute("aria-expanded"), "true");

		const child = dom.window.document.querySelector<HTMLButtonElement>('.ash-context-view-menu:not([hidden]) [role="menuitem"]')!;
		child.focus();
		mock.timers.tick(750);
		assert.equal(trigger.getAttribute("aria-expanded"), "true");

		trigger.parentElement!.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
		leaf.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		mock.timers.tick(749);
		assert.equal(trigger.getAttribute("aria-expanded"), "true");
		mock.timers.tick(1);
		assert.equal(trigger.getAttribute("aria-expanded"), "false");
		assert.equal(dom.window.document.activeElement, leaf);

		trigger.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
		trigger.dispatchEvent(movement);
		mock.timers.tick(250);
		assert.equal(trigger.getAttribute("aria-expanded"), "true");
		const unrelatedScroller = dom.window.document.createElement("div");
		dom.window.document.body.append(unrelatedScroller);
		unrelatedScroller.dispatchEvent(new dom.window.Event("scroll"));
		assert.equal(trigger.getAttribute("aria-expanded"), "true");
		dom.window.document.body.dispatchEvent(new dom.window.Event("scroll"));
		assert.equal(trigger.getAttribute("aria-expanded"), "false");
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "Node");
		mock.timers.reset();
	}
});

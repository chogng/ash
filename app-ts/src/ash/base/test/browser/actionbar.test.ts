import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IAction } from "../../common/actions.js";
import { Separator } from "../../common/actions.js";
import { lxiconsLibrary } from "../../common/lxiconsLibrary.js";
import { ActionBar } from "../../browser/ui/actionbar/actionbar.js";
import { LabelActionViewItem } from "../../browser/ui/actionbar/actionViewItems.js";
import { setHoverDelegate, type HoverDelegateSetupOptions, type IManagedHover } from "../../browser/ui/hover/hoverDelegate.js";
import { AnchorPosition } from "../../common/layout.js";

test("ActionViewItem routes its tooltip through the shared action Hover group", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const setups: HoverDelegateSetupOptions[] = [];
	using delegateRegistration = setHoverDelegate({
		setupHover(options) {
			setups.push(options);
			options.target.removeAttribute("title");
			return managedHover();
		},
	});
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action("open")],
		actionViewItemOptions: { hoverAnchorPosition: AnchorPosition.Below },
	});
	dom.window.document.body.append(actionBar.element);

	const button = actionBar.element.querySelector("button");
	assert.ok(button);
	assert.equal(setups.length, 1);
	assert.equal(setups[0]?.target, button);
	assert.equal(setups[0]?.content, "open");
	assert.equal(setups[0]?.groupId, "actions");
	assert.equal(setups[0]?.anchorPosition, AnchorPosition.Below);
	assert.equal(button.hasAttribute("title"), false);

	dom.window.close();
});

test("LabelActionViewItem owns compact icon-and-text action markup", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	let runCount = 0;
	const activeAction: IAction = {
		id: "active-terminal",
		label: "Focus Active Terminal",
		tooltip: "Focus Active Terminal",
		enabled: true,
		run: () => runCount++,
	};
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [activeAction],
		actionViewItemProvider: (action) => new LabelActionViewItem(action, {
			label: "cmd",
			icon: lxiconsLibrary.terminalCmd,
			ariaLabel: "Active terminal: cmd",
			tooltip: "Active terminal: cmd",
		}),
	});
	dom.window.document.body.append(actionBar.element);

	const label = actionBar.element.querySelector<HTMLButtonElement>(".ash-action-label");
	assert.ok(label);
	assert.equal(label.classList.contains("ash-button"), false);
	assert.equal(label.querySelector(".ash-action-label-text")?.textContent, "cmd");
	assert.ok(label.querySelector(".ash-action-label-icon > svg.ash-icon"));
	assert.equal(label.getAttribute("aria-label"), "Active terminal: cmd");
	assert.equal(label.tabIndex, 0);
	label.click();
	assert.equal(runCount, 1);

	dom.window.close();
});

test("ActionBar enables native drag sources only when its view item opts in", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action("drag-source"), action("ordinary")],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, {
			draggable: item.id === "drag-source",
		}),
	});
	dom.window.document.body.append(actionBar.element);

	const [source, ordinary] = actionBar.element.querySelectorAll<HTMLElement>(".ash-action-view-item");
	assert.ok(source);
	assert.ok(ordinary);
	assert.equal(source.draggable, true);
	assert.equal(source.classList.contains("ash-dnd-draggable"), true);
	assert.equal(ordinary.draggable, false);
	assert.equal(ordinary.classList.contains("ash-dnd-draggable"), false);

	dom.window.close();
});

test("ActionBar reports drop targets without enabling ordinary toolbars", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const dropped: Array<{ target: string | undefined; position: string }> = [];
	let dragging = false;
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action("first"), action("second")],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, { draggable: true }),
		dragAndDrop: {
			canDrop: () => dragging,
			onDragStart: () => {
				dragging = true;
			},
			onDrop: (target, position) => dropped.push({ target: target?.id, position }),
			onDragEnd: () => {
				dragging = false;
			},
		},
	});
	dom.window.document.body.append(actionBar.element);
	assert.equal(actionBar.element.classList.contains("ash-action-bar-dnd"), true);
	const [first, second] = actionBar.element.querySelectorAll<HTMLElement>(".ash-action-view-item");
	assert.ok(first);
	assert.ok(second);
	Object.defineProperty(second, "getBoundingClientRect", {
		value: () => ({ left: 100, width: 100 }),
	});

	first.dispatchEvent(dragEvent(dom.window, "dragstart"));
	second.dispatchEvent(dragEvent(dom.window, "dragover", 175));
	assert.equal(second.classList.contains("ash-dnd-drop-after"), true);
	second.dispatchEvent(dragEvent(dom.window, "drop", 175));

	assert.deepEqual(dropped, [{ target: "second", position: "after" }]);
	assert.equal(dragging, false);
	dom.window.close();
});

test("ActionBar keeps insertion feedback continuous across gaps and hides no-op drops", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const dropped: string[] = [];
	let dragging = false;
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action("first"), action("second"), action("third")],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, { draggable: true }),
		dragAndDrop: {
			canDrop: () => dragging,
			onDragStart: () => {
				dragging = true;
			},
			onDrop: (target, position) => dropped.push(`${target?.id}:${position}`),
			onDragEnd: () => {
				dragging = false;
			},
		},
	});
	dom.window.document.body.append(actionBar.element);
	const [first, second, third] = actionBar.element.querySelectorAll<HTMLElement>(".ash-action-view-item");
	assert.ok(first);
	assert.ok(second);
	assert.ok(third);
	first.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
	second.getBoundingClientRect = () => ({ left: 104, width: 100 } as DOMRect);
	third.getBoundingClientRect = () => ({ left: 208, width: 100 } as DOMRect);

	third.dispatchEvent(dragEvent(dom.window, "dragstart"));
	actionBar.element.dispatchEvent(dragEvent(dom.window, "dragover", 102));
	assert.equal(second.classList.contains("ash-dnd-drop-before"), true);
	actionBar.element.dispatchEvent(dragEvent(dom.window, "drop", 102));
	assert.deepEqual(dropped, ["second:before"]);

	first.dispatchEvent(dragEvent(dom.window, "dragstart"));
	const dataTransfer = testDataTransfer();
	second.dispatchEvent(dragEvent(dom.window, "dragover", 125, dataTransfer));
	assert.equal(second.classList.contains("ash-dnd-drop-before"), false);
	assert.equal(dataTransfer.dropEffect, "move");
	second.dispatchEvent(dragEvent(dom.window, "drop", 125));
	assert.deepEqual(dropped, ["second:before"]);
	assert.equal(dragging, false);
	dom.window.close();
});

test("ActionBar owns horizontal keyboard navigation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const actionBar = new ActionBar(dom.window.document.body, {
		actions: [
			action("first"),
			new Separator(),
			action("disabled", false),
			action("last"),
		],
	});
	dom.window.document.body.append(actionBar.element);
	const buttons = actionBar.element.querySelectorAll("button");
	const first = buttons[0];
	const disabled = buttons[1];
	const last = buttons[2];
	assert.ok(first);
	assert.ok(disabled);
	assert.ok(last);
	assert.equal(actionBar.element.getAttribute("role"), "toolbar");
	assert.equal(actionBar.element.getAttribute("aria-orientation"), "horizontal");
	assert.deepEqual(
		[...buttons].map((button) => button.tabIndex),
		[0, -1, -1],
	);

	first.focus();
	first.dispatchEvent(keyboardEvent(dom.window, "ArrowRight"));
	assert.equal(dom.window.document.activeElement, last);
	assert.deepEqual(
		[...buttons].map((button) => button.tabIndex),
		[-1, -1, 0],
	);
	last.dispatchEvent(keyboardEvent(dom.window, "ArrowRight"));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, "ArrowLeft"));
	assert.equal(dom.window.document.activeElement, last);
	last.dispatchEvent(keyboardEvent(dom.window, "Home"));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, "End"));
	assert.equal(dom.window.document.activeElement, last);

	actionBar.dispose();
	dom.window.close();
});

test("ActionBar maps vertical navigation to up and down", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const actionBar = new ActionBar(dom.window.document.body, {
		actions: [action("first"), action("second")],
		orientation: "vertical",
	});
	dom.window.document.body.append(actionBar.element);
	const buttons = actionBar.element.querySelectorAll("button");
	const first = buttons[0];
	const second = buttons[1];
	assert.ok(first);
	assert.ok(second);
	assert.equal(actionBar.element.getAttribute("role"), "toolbar");
	assert.equal(actionBar.element.getAttribute("aria-orientation"), "vertical");

	first.focus();
	first.dispatchEvent(keyboardEvent(dom.window, "ArrowDown"));
	assert.equal(dom.window.document.activeElement, second);
	second.dispatchEvent(keyboardEvent(dom.window, "ArrowUp"));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, "ArrowRight"));
	assert.equal(dom.window.document.activeElement, first);

	actionBar.dispose();
	dom.window.close();
});

function action(
	id: string,
	enabled = true,
): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled,
		run() {},
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

function dragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0, dataTransfer?: DataTransfer): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	return event;
}

function testDataTransfer(): DataTransfer {
	return { dropEffect: "none", effectAllowed: "none", setData() {} } as unknown as DataTransfer;
}

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}

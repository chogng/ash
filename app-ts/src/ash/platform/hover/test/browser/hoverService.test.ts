import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../base/common/event.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../../../../base/common/layout.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { InMemoryConfigurationService } from "../../../configuration/common/inMemoryConfigurationService.js";
import type { IContextMenuService } from "../../../contextview/browser/contextView.js";
import { HoverConfiguration } from "../../common/hoverService.js";
import { h } from "../../../../base/browser/dom.js";

const environment = new JSDOM("<!doctype html><html><body><main><button id='first'>First</button><button id='second'>Second</button></main></body></html>");
Object.defineProperties(globalThis, {
	window: { configurable: true, value: environment.window },
	document: { configurable: true, value: environment.window.document },
	Node: { configurable: true, value: environment.window.Node },
});
Object.defineProperties(environment.window, {
	innerWidth: { configurable: true, value: 800 },
	innerHeight: { configurable: true, value: 600 },
});

const { BrowserContextViewService } = await import("../../../contextview/browser/contextViewService.js");
const { HoverService } = await import("../../browser/hoverService.js");

test("HoverService coordinates grouped Hovers and context menus", async () => {
	const container = requiredElement<HTMLElement>("main");
	const firstTarget = requiredElement<HTMLButtonElement>("#first");
	const secondTarget = requiredElement<HTMLButtonElement>("#second");
	firstTarget.getBoundingClientRect = () => rectangle(20, 60, 80, 24);
	secondTarget.getBoundingClientRect = () => rectangle(120, 60, 80, 24);
	const contextViews = new BrowserContextViewService(container);
	const contextViewElement = container.querySelector<HTMLElement>(".ash-context-view");
	assert.ok(contextViewElement);
	contextViewElement.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	const contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(HoverConfiguration.delay, 1_000);
	const hoverService = new HoverService(
		configuration,
		contextViews,
		contextMenus,
	);

	const first = hoverService.showHover({
		target: firstTarget,
		content: "First Hover",
		groupId: "test.items",
	});
	assert.equal(first.visible, true);
	assert.equal(contextViewElement.textContent, "First Hover");

	const second = hoverService.setupHover({
		target: secondTarget,
		content: "Second Hover",
		groupId: "test.items",
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		anchorPosition: AnchorPosition.Below,
		gap: 8,
	});
	secondTarget.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	await nextTimer();
	assert.equal(second.visible, true);
	assert.equal(first.visible, false);
	assert.equal(contextViewElement.textContent, "Second Hover");
	assert.equal(contextViewElement.style.left, "208px");
	assert.equal(contextViewElement.style.top, "60px");
	assert.equal(contextViewElement.classList.contains("ash-context-view-axis-horizontal"), true);

	contextMenus.show();
	assert.equal(second.visible, false);
	firstTarget.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	await nextTimer();
	assert.equal(first.visible, false);

	contextMenus.hide();
	first.show();
	assert.equal(first.visible, true);
	hoverService.hideHover();
	assert.equal(first.visible, false);

	second.dispose();
	first.dispose();
	hoverService.dispose();
	contextMenus.dispose();
	contextViews.dispose();
});

test("HoverService suppresses replacement Hovers until the pointer moves after activation", async () => {
	const container = requiredElement<HTMLElement>("main");
	const previousTarget = h(environment.window.document, "button");
	previousTarget.textContent = "Previous Action";
	container.append(previousTarget);
	previousTarget.getBoundingClientRect = () => rectangle(20, 100, 100, 24);
	const target = h(environment.window.document, "button");
	target.textContent = "Action";
	container.append(target);
	target.getBoundingClientRect = () => rectangle(140, 100, 80, 24);
	const contextViews = new BrowserContextViewService(container);
	const contextViewElement = container.querySelector<HTMLElement>(".ash-context-view");
	assert.ok(contextViewElement);
	contextViewElement.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	const contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(HoverConfiguration.delay, 0);
	const hoverService = new HoverService(configuration, contextViews, contextMenus);
	const previousHover = hoverService.setupHover({ target: previousTarget, content: "Previous Action Hover", groupId: "actions" });
	const hover = hoverService.setupHover({ target, content: "Action Hover", groupId: "actions" });

	previousHover.show();
	assert.equal(previousHover.visible, true);
	target.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	target.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));
	target.dispatchEvent(new environment.window.FocusEvent("focusin", { bubbles: true }));
	target.dispatchEvent(new environment.window.MouseEvent("pointerup", { bubbles: true }));
	target.dispatchEvent(new environment.window.MouseEvent("click", { bubbles: true }));
	assert.equal(previousHover.visible, false);
	assert.equal(hover.visible, false);

	const replacementTarget = h(environment.window.document, "button");
	replacementTarget.textContent = "Replacement Action";
	container.append(replacementTarget);
	replacementTarget.getBoundingClientRect = () => rectangle(140, 100, 80, 24);
	const replacementHover = hoverService.setupHover({ target: replacementTarget, content: "Action Hover", groupId: "actions" });
	replacementTarget.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	await nextTimer();
	assert.equal(replacementHover.visible, false);

	replacementTarget.dispatchEvent(new environment.window.MouseEvent("pointermove", { bubbles: true, buttons: 0, clientX: 145, clientY: 100 }));
	replacementTarget.dispatchEvent(new environment.window.MouseEvent("pointerenter"));
	await nextTimer();
	assert.equal(replacementHover.visible, true);
	replacementHover.hide();

	target.dispatchEvent(new environment.window.FocusEvent("focusout", { bubbles: true }));
	target.dispatchEvent(new environment.window.FocusEvent("focusin", { bubbles: true }));
	assert.equal(hover.visible, true);

	hoverService.dispose();
	contextMenus.dispose();
	contextViews.dispose();
	previousTarget.remove();
	target.remove();
	replacementTarget.remove();
});

class TestContextMenuService extends Disposable implements IContextMenuService {
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	show(): void {
		this._onDidShowContextMenu.fire();
	}

	hide(): void {
		this._onDidHideContextMenu.fire();
	}

	showContextMenu(): void {}
	hideContextMenu(): void {}
}

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

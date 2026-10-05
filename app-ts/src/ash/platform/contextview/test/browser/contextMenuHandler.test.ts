import { Disposable } from '../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Event } from "../../../../base/common/event.js";
import { DisposableTracker, installDisposableTracker } from "../../../../base/common/lifecycle.js";
import type { IKeybindingService } from "../../../keybinding/common/keybinding.js";
import type { INotificationService } from "../../../notification/common/notification.js";
import type { IContextViewService } from "../../browser/contextView.js";
import { ContextViewHideReason, type ContextViewOptions } from "../../../../base/browser/ui/contextview/contextview.js";

test("context menus focus the container unless first-item selection is requested", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousNode = Object.getOwnPropertyDescriptor(globalThis, "Node");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
	Object.defineProperty(dom.window.Element.prototype, "getClientRects", { value: () => [{}] });
	Object.defineProperty(dom.window.Element.prototype, "scrollTo", { value(): void {} });
	try {
		const { ContextMenuHandler } = await import("../../browser/contextMenuHandler.js");
		let options: ContextViewOptions | undefined;
		const contextView: IContextViewService = {
			container: dom.window.document.body,
			show(value) { options = value; return true; },
			hide() { options?.onHide?.(ContextViewHideReason.Programmatic); options = undefined; },
			layout() {},
		};
		using handler = new ContextMenuHandler(contextView, {
			lookupKeybinding() { return undefined; },
		} as unknown as IKeybindingService, {
			error(error: unknown) { throw error; },
		} as unknown as INotificationService);
		for (const autoSelectFirstItem of [undefined, false, true]) {
			handler.showContextMenu({
				getAnchor: () => dom.window.document.body,
				getActions: () => [{ id: "run", label: "Run", tooltip: "Run", enabled: true, run() {} }],
				autoSelectFirstItem,
			});
			const menu = dom.window.document.querySelector<HTMLElement>('[role="menu"]')!;
			assert.equal(dom.window.document.activeElement, autoSelectFirstItem ? menu.querySelector('[role="menuitem"]') : menu);
			assert.equal(menu.querySelectorAll('.focused').length, autoSelectFirstItem ? 1 : 0);
		}
	} finally {
		dom.window.close();
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (previousNode) Object.defineProperty(globalThis, "Node", previousNode);
		else Reflect.deleteProperty(globalThis, "Node");
	}
});

test("a context menu that cannot be shown releases its execution resources", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
	const { ContextMenuHandler } = await import("../../browser/contextMenuHandler.js");
	const { getWindowId } = await import("../../../../base/browser/window.js");
	// Window registration belongs to the DOM fixture, outside the handler's leak boundary.
	getWindowId(dom.window as unknown as Window);
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const contextView = {
		container: dom.window.document.body,
		show() { return false; },
		hide() {},
		layout() {},
	} as IContextViewService;
	const keybindings = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	using handler = new ContextMenuHandler(contextView, keybindings, {
		error(error: unknown) { throw error; },
	} as unknown as INotificationService);
	const ownedBefore = tracker.leaks().map(leak => leak.label).sort();
	let hideCount = 0;
	for (let index = 0; index < 3; index++) {
		assert.equal(handler.showContextMenu({
			getAnchor: () => ({ x: 10, y: 20, targetWindow: dom.window as unknown as Window }),
			getActions: () => [{ id: "run", label: "Run", tooltip: "Run", enabled: true, run() {} }],
			onHide: (cancelled) => {
				assert.equal(cancelled, true);
				hideCount++;
			},
		}), false);
		assert.deepEqual(tracker.leaks().map(leak => leak.label).sort(), ownedBefore);
	}
	assert.equal(hideCount, 3);
	handler.dispose();
	tracker.assertNoLeaks();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

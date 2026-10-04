import { Disposable } from '../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Event } from "../../../../base/common/event.js";
import { DisposableTracker, installDisposableTracker } from "../../../../base/common/lifecycle.js";
import type { IKeybindingService } from "../../../keybinding/common/keybinding.js";
import type { INotificationService } from "../../../notification/common/notification.js";
import type { IContextViewService } from "../../browser/contextView.js";

test("a context menu that cannot be shown releases its execution resources", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
	Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
	const { ContextMenuHandler } = await import("../../browser/contextMenuHandler.js");
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

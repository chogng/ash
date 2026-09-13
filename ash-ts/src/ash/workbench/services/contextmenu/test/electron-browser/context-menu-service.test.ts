import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Event } from "../../../../../base/common/event.js";
import type { INativeContextMenuApi } from "../../../../../base/parts/contextmenu/common/contextmenu.js";
import type { IMenuService } from "../../../../../platform/actions/common/menuService.js";
import { ContextKeyService } from "../../../../../platform/contextkey/common/contextkey.js";
import type { IKeybindingService } from "../../../../../platform/keybinding/common/keybinding.js";
import type { INotificationService } from "../../../../../platform/notification/common/notification.js";

test("Electron context menus run the selected action with its delegate context", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: environment.window,
	});
	const { NativeContextMenuService } = await import(
		"../../electron-browser/contextMenuService.js"
	);
	const api: INativeContextMenuApi = {
		async popup() {
			return { selectedId: "action-1" };
		},
		async close() {},
	};
	using contextKeyService = new ContextKeyService();
	const keybindingService = {
		inChordMode: false,
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	const notificationService = {
		error(message: string) {
			throw new Error(`Unexpected notification: ${message}`);
		},
	} as unknown as INotificationService;
	using service = new NativeContextMenuService(
		api,
		{} as IMenuService,
		contextKeyService,
		keybindingService,
		notificationService,
	);
	const actionContext = { resource: "test.txt" };
	let receivedContext: unknown;
	let didCancel: boolean | undefined;
	service.showContextMenu({
		getAnchor: () => ({
			x: 10,
			y: 20,
			targetWindow: environment.window as unknown as Window,
		}),
		getActions: () => [{
			id: "run",
			label: "Run",
			tooltip: "Run",
			enabled: true,
			run(context) {
				receivedContext = context;
			},
		}],
		getActionsContext: () => actionContext,
		onHide: (cancelled) => {
			didCancel = cancelled;
		},
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	assert.equal(receivedContext, actionContext);
	assert.equal(didCancel, false);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

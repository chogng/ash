import { Disposable } from '../../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Event } from "../../../../../base/common/event.js";
import { AnchorAlignment, AnchorAxisAlignment, ContextViewHideReason, type ContextViewOptions } from "../../../../../base/browser/ui/contextview/contextview.js";
import type { INativeContextMenuApi, INativeContextMenuRequest, INativeContextMenuResult } from "../../../../../base/parts/contextmenu/common/contextmenu.js";
import type { IMenuService } from "../../../../../platform/actions/common/actions.js";
import { ContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { ConfigurationRegistry } from "../../../../../platform/configuration/common/configurationRegistry.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
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
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
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

test("Electron context menus position element and point anchors in CSS pixels", async () => {
	const environment = new JSDOM("<!doctype html><body><button></button></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: environment.window });
	const { NativeContextMenuService } = await import("../../electron-browser/contextMenuService.js");
	const requests: INativeContextMenuRequest[] = [];
	const api: INativeContextMenuApi = {
		async popup(request) { requests.push(request); return {}; },
		async close() {},
	};
	using contextKeyService = new ContextKeyService();
	const keybindingService = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	using service = new NativeContextMenuService(
		api,
		{} as IMenuService,
		contextKeyService,
		keybindingService,
		{ error: (error: unknown) => { throw error; } } as unknown as INotificationService,
	);
	const button = environment.window.document.querySelector("button")!;
	button.getBoundingClientRect = () => ({ left: 100.25, top: 50.5, right: 140.25, bottom: 70.5, width: 40, height: 20, x: 100.25, y: 50.5, toJSON: () => ({}) });
	const action = { id: "open", label: "Open", tooltip: "Open", enabled: true, run() {} };
	service.showContextMenu({
		getAnchor: () => button,
		getActions: () => [action],
		anchorAlignment: AnchorAlignment.Right,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		autoSelectFirstItem: true,
	});
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	button.getBoundingClientRect = () => ({ left: -10, top: -5, right: 30, bottom: 20, width: 40, height: 25, x: -10, y: -5, toJSON: () => ({}) });
	service.showContextMenu({ getAnchor: () => button, getActions: () => [action] });
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	service.showContextMenu({
		getAnchor: () => ({ x: 10.25, y: 20.5, targetWindow: environment.window as unknown as Window }),
		getActions: () => [action],
	});
	await new Promise<void>(resolve => setTimeout(resolve, 0));

	assert.deepEqual(requests.map(({ x, y, elementAnchor, positioningItem }) => ({ x, y, elementAnchor, positioningItem })), [
		{ x: 140.25, y: 50.5, elementAnchor: true, positioningItem: 0 },
		{ x: 30, y: 20, elementAnchor: true, positioningItem: undefined },
		{ x: 10.25, y: 20.5, elementAnchor: undefined, positioningItem: undefined },
	]);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("macOS switches context menu implementation when the menu style changes", async () => {
	if (process.platform !== "darwin") return;
	const environment = new JSDOM("<!doctype html><body><button></button></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: environment.window });
	Object.defineProperty(globalThis, "Node", { configurable: true, value: environment.window.Node });
	const { createElectronWorkbenchContextMenuService } = await import("../../electron-browser/contextMenuService.js");
	let finishPopup!: (result: INativeContextMenuResult) => void;
	const api: INativeContextMenuApi = {
		popup: () => new Promise(resolve => { finishPopup = resolve; }),
		async close() {},
	};
	let activeView: ContextViewOptions | undefined;
	const contextView = {
		container: environment.window.document.body,
		show(options: ContextViewOptions) {
			activeView = options;
			this.container.append(options.content);
			return true;
		},
		hide() {
			const current = activeView;
			activeView = undefined;
			current?.onHide?.(ContextViewHideReason.Programmatic);
			current?.content.remove();
		},
		layout() {},
	} as IContextViewService;
	using contextKeyService = new ContextKeyService();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: "window.menuStyle", defaultValue: "system", parse: value => value });
	registry.registerConfiguration({ key: "window.titleBarStyle", defaultValue: "custom", parse: value => value });
	using configurationService = new InMemoryConfigurationService(registry);
	const keybindingService = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	using service = createElectronWorkbenchContextMenuService({
		configurationService,
		menuService: {} as IMenuService,
		contextKeyService,
		keybindingService,
		contextViewService: contextView,
		notificationService: { error: (error: unknown) => { throw error; } } as unknown as INotificationService,
	}, api);
	const events: string[] = [];
	using shown = service.onDidShowContextMenu(() => events.push("show"));
	using hidden = service.onDidHideContextMenu(() => events.push("hide"));
	const action = { id: "open", label: "Open", tooltip: "Open", enabled: true, run() {} };
	service.showContextMenu({
		getAnchor: () => ({ x: 10, y: 20, targetWindow: environment.window as unknown as Window }),
		getActions: () => [action],
	});
	finishPopup({});
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	await configurationService.updateValue("window.menuStyle", "custom");
	service.showContextMenu({
		getAnchor: () => environment.window.document.querySelector("button")!,
		getActions: () => [action],
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
	});
	assert.deepEqual(events, ["show", "hide", "show"]);
	service.hideContextMenu();
	assert.deepEqual(events, ["show", "hide", "show", "hide"]);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

import { ContextKeyExpr } from "../../../contextkey/common/contextkey.js";
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../base/browser/dom.js";
import { Event } from "../../../../base/common/event.js";

test("toolbar submenu items retain toolbar button semantics", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	const [
		{ MenuId, SubmenuItemAction },
		{ createActionViewItem },
	] =
		await Promise.all([
			import("../../../../platform/actions/common/actions.js"),
			import("../../../../platform/actions/browser/menuEntryActionViewItem.js"),
		]);
	let shownOptions:
		| import("../../../../base/browser/contextmenu.js").IContextMenuDelegate
		| undefined;
	const childAction = {
		id: "test.toolbar.child",
		label: "Child",
		tooltip: "Child",
		enabled: true,
		run() {},
	};
	const item = createActionViewItem(
		new SubmenuItemAction({
			title: "More",
			submenu: MenuId.for("test.toolbar.submenu"),
		}, [childAction]),
		{
			showContextMenu(options) {
				shownOptions = options;
			},
		},
	);
	assert.ok(item);
	const container = h(dom.window.document, "div");
	dom.window.document.body.append(container);

	item.render(container);

	const button = container.querySelector("button");
	assert.ok(button instanceof dom.window.HTMLButtonElement);
	assert.equal(button.hasAttribute("role"), false);
	assert.equal(button.getAttribute("aria-haspopup"), "menu");
	assert.ok(button.querySelector(
		".ash-dropdown-menu-indicator > svg.ash-icon",
	));
	button.click();
	assert.ok(shownOptions);
	assert.equal(shownOptions.getAnchor(), button);
	assert.deepEqual(shownOptions.getActions(), [childAction]);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	shownOptions.onHide?.(false);
	assert.equal(button.getAttribute("aria-expanded"), "false");

	item.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("menu entry actions switch to their alternative while Alt is held", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const [
		{ ModifierKeyEmitter },
		{ MenuItemAction },
		{ ContextKeyService },
		{ createActionViewItem, resolveAlternativeMenuActions },
	] = await Promise.all([
		import("../../../../base/browser/dom.js"),
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/actions/browser/menuEntryActionViewItem.js"),
	]);
	const runs: string[] = [];
	const commandService = {
		executeCommand: async (id: string) => {
			runs.push(id);
		},
	} as unknown as import("../../../../platform/commands/common/commands.js").ICommandService;
	using contexts = new ContextKeyService();
	const alternate = new MenuItemAction(
		{ id: "test.toolbar.alternative", title: "Alternative" },
		undefined,
		undefined,
		contexts,
		commandService,
	);
	const primary = new MenuItemAction(
		{ id: "test.toolbar.primary", title: "Primary" },
		alternate,
		undefined,
		contexts,
		commandService,
	);
	const item = createActionViewItem(primary, { showContextMenu() {} });
	assert.ok(item);
	const container = h(dom.window.document, "div");
	dom.window.document.body.append(container);
	item.render(container);
	const button = container.querySelector("button");
	assert.ok(button instanceof dom.window.HTMLButtonElement);

	container.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
	dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Alt", altKey: true }));
	assert.equal(button.textContent, "Alternative");
	button.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(runs, ["test.toolbar.alternative"]);
	assert.equal(resolveAlternativeMenuActions([primary], true)[0]?.id, "test.toolbar.alternative");

	dom.window.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Alt" }));
	assert.equal(button.textContent, "Primary");
	button.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(runs, ["test.toolbar.alternative", "test.toolbar.primary"]);

	item.dispose();
	ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
	dom.window.close();
});

test("DropdownWithPrimaryActionViewItem presents one split toolbar item", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const [
		{ DropdownWithPrimaryActionViewItem },
		{ ToolBar },
	] = await Promise.all([
		import("../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js"),
		import("../../../../base/browser/ui/toolbar/toolbar.js"),
	]);
	let shownOptions: import("../../../../base/browser/contextmenu.js").IContextMenuDelegate | undefined;
	const contextMenuProvider = {
		showContextMenu(options: import("../../../../base/browser/contextmenu.js").IContextMenuDelegate) {
			shownOptions = options;
		},
	};
	let primaryRuns = 0;
	const primaryAction = { ...testAction("new"), run: () => primaryRuns++ };
	const dropdownAction = testAction("select-profile");
	let splitViewItem: import("../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js").DropdownWithPrimaryActionViewItem | undefined;
	using toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider,
		actionViewItemProvider: (item, options) => {
			splitViewItem = new DropdownWithPrimaryActionViewItem(item, dropdownAction, [testAction("cmd")], contextMenuProvider, options);
			return splitViewItem;
		},
	});
	toolbar.setActions([primaryAction]);
	dom.window.document.body.append(toolbar.element);
	assert.ok(splitViewItem);
	const visibility: boolean[] = [];
	splitViewItem.onDidChangeDropdownVisibility((visible) => visibility.push(visible));

	const splitItem = toolbar.element.querySelector<HTMLElement>(".ash-dropdown-with-primary-action-view-item");
	const primaryButton = splitItem?.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-primary > .ash-button");
	const dropdownButton = splitItem?.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(splitItem);
	assert.ok(primaryButton);
	assert.ok(dropdownButton);
	assert.equal(toolbar.element.querySelectorAll(":scope > .ash-action-view-item").length, 1);
	assert.equal(primaryButton.tabIndex, 0);
	assert.equal(dropdownButton.tabIndex, -1);

	primaryButton.click();
	assert.equal(primaryRuns, 1);
	primaryButton.focus();
	primaryButton.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));
	assert.equal(dom.window.document.activeElement, dropdownButton);
	assert.equal(primaryButton.tabIndex, -1);
	assert.equal(dropdownButton.tabIndex, 0);
	dropdownButton.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" }));
	assert.equal(dom.window.document.activeElement, primaryButton);

	dropdownButton.click();
	assert.equal(shownOptions?.getAnchor(), dropdownButton);
	assert.deepEqual(shownOptions?.getActions().map(({ id }) => id), ["cmd"]);
	assert.equal(dropdownButton.getAttribute("aria-expanded"), "true");
	assert.equal(splitItem.classList.contains("active"), true);
	shownOptions?.onHide?.(false);
	assert.equal(dropdownButton.getAttribute("aria-expanded"), "false");
	assert.equal(splitItem.classList.contains("active"), false);
	assert.deepEqual(visibility, [true, false]);

	splitViewItem.update(testAction("select-other"), [testAction("other")]);
	const updatedDropdownButton = splitItem.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(updatedDropdownButton);
	assert.notEqual(updatedDropdownButton, dropdownButton);
	splitViewItem.focus(true);
	assert.equal(dom.window.document.activeElement, updatedDropdownButton);
	splitViewItem.showDropdown();
	assert.deepEqual(shownOptions?.getActions().map(({ id }) => id), ["other"]);
	assert.equal(splitItem.classList.contains("active"), true);
	splitViewItem.update(testAction("select-final"), [testAction("final")]);
	assert.equal(splitItem.classList.contains("active"), false);
	splitViewItem.showDropdown();
	assert.deepEqual(shownOptions?.getActions().map(({ id }) => id), ["final"]);
	shownOptions?.onHide?.(false);
	assert.deepEqual(visibility, [true, false, true, false, true, false]);

	dom.window.close();
});

test("menu action grouping supports primary predicates, separators, and submenu inlining", async () => {
	const [
		{ Separator, SubmenuAction },
		{ getActionBarActions, getFlatContextMenuActions },
	] = await Promise.all([
		import("../../../../base/common/actions.js"),
		import("../../../../platform/actions/browser/menuEntryActionViewItem.js"),
	]);
	const first = testAction("first");
	const second = testAction("second");
	const child = testAction("child");
	const trailing = testAction("trailing");
	const submenu = new SubmenuAction("submenu", "Submenu", [child]);
	const groups = [
		["primary.one", [first]],
		["primary.two", [submenu]],
		["secondary.one", [second]],
		["secondary.two", [trailing]],
	] as const;

	const grouped = getActionBarActions(
		groups,
		(group) => group.startsWith("primary."),
		(action) => action === submenu,
		true,
	);

	assert.deepEqual(grouped.primary.map(({ id }) => id), [
		"first",
		Separator.ID,
		"child",
	]);
	assert.deepEqual(grouped.secondary.map(({ id }) => id), [
		"second",
		Separator.ID,
		"trailing",
	]);
	assert.deepEqual(
		getFlatContextMenuActions(groups, undefined, undefined).map(({ id }) => id),
		["first", Separator.ID, "submenu", Separator.ID, "second", Separator.ID, "trailing"],
	);
});

test("menu toolbar applies custom primary groups and submenu inlining", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const [
		{ SubmenuAction },
		{ Event },
		{ MenuId },
		{ MenuWorkbenchToolBar },
	] = await Promise.all([
		import("../../../../base/common/actions.js"),
		import("../../../../base/common/event.js"),
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/actions/browser/toolbar.js"),
	]);
	const child = testAction("inline-child");
	const secondary = testAction("secondary");
	const groups = [
		["inline", [new SubmenuAction("submenu", "Submenu", [child])]],
		["secondary", [secondary]],
	] as const;
	const menu = {
		onDidChange: Event.None,
		getActions: () => groups,
		dispose() {},
		[Symbol.dispose]() {},
	};
	const menuService = {
		createMenu: () => menu,
		getMenuActions: () => groups,
	} as import("../../../../platform/actions/common/actions.js").IMenuService;
	using toolbar = new MenuWorkbenchToolBar(
		dom.window.document.body,
		menuService,
		{ showContextMenu() {} },
		MenuId.for("test.toolbar.custom-groups"),
		{
			toolbarOptions: {
				primaryGroup: "inline",
				shouldInlineSubmenu: () => true,
			},
		},
	);

	assert.deepEqual(
		[...toolbar.element.querySelectorAll<HTMLElement>("[data-action-id]")]
			.map(({ dataset }) => dataset.actionId),
		["inline-child", "ash.toolbar.moreActions"],
	);
	dom.window.close();
});

test("workbench toolbar adapts manually supplied platform menu actions", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	const [
		{ MenuId, MenusRegistry },
		{ MenuService },
		{ CommandsRegistry },
		{ ContextKeyService },
		{ ServiceContainer },
		{ CommandService },
		{ DisposableStore },
		{ WorkbenchToolBar },
	] = await Promise.all([
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/actions/common/menuService.js"),
		import("../../../../platform/commands/common/commands.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../workbench/services/commands/common/commandService.js"),
		import("../../../../base/common/lifecycle.js"),
		import("../../../../platform/actions/browser/toolbar.js"),
	]);
	using registrations = new DisposableStore();
	const menuId = new MenuId("test.toolbar.workbench");
	const commandId = "test.toolbar.workbench.action";
	registrations.add(CommandsRegistry.register(commandId, () => undefined));
	registrations.add(MenusRegistry.appendMenuItem(menuId, {
		command: { id: commandId, title: "Workbench action" },
		group: "navigation",
	}));
	const commands = new CommandService(new ServiceContainer());
	const contexts = registrations.add(new ContextKeyService());
	const menus = new MenuService(commands, contexts);
	const action = menus.getMenuActions(menuId)[0]?.[1][0];
	assert.ok(action);
	const toolbar = new WorkbenchToolBar(dom.window.document.body, { showContextMenu() {} });
	toolbar.setActions([action]);
	dom.window.document.body.append(toolbar.element);

	assert.equal(toolbar.element.querySelector(".ash-menu-entry button")?.textContent, "Workbench action");

	toolbar.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("menu toolbar keeps navigation inline and moves other groups into More Actions", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	const [
		{ MenuId, MenusRegistry },
		{ MenuService },
		{ CommandsRegistry },
		{ ContextKeyService },
		{ ServiceContainer },
		{ CommandService },
		{ DisposableStore },
		{ MenuWorkbenchToolBar },
	] = await Promise.all([
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/actions/common/menuService.js"),
		import("../../../../platform/commands/common/commands.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../workbench/services/commands/common/commandService.js"),
		import("../../../../base/common/lifecycle.js"),
		import("../../../../platform/actions/browser/toolbar.js"),
	]);
	using registrations = new DisposableStore();
	const menuId = new MenuId("test.toolbar.groups");
	registrations.add(CommandsRegistry.register(
		"test.toolbar.navigation",
		() => undefined,
	));
	registrations.add(CommandsRegistry.register(
		"test.toolbar.secondary",
		() => undefined,
	));
	registrations.add(MenusRegistry.appendMenuItem(menuId, {
		command: {
			id: "test.toolbar.navigation",
			title: "Navigation",
		},
		group: "navigation",
	}));
	registrations.add(MenusRegistry.appendMenuItem(menuId, {
		command: {
			id: "test.toolbar.secondary",
			title: "Secondary",
		},
		group: "other",
	}));
	const commands = new CommandService(new ServiceContainer());
	const contexts = registrations.add(new ContextKeyService());
	const menus = new MenuService(commands, contexts);
	let shownOptions:
		| import("../../../../base/browser/contextmenu.js").IContextMenuDelegate
		| undefined;
	const toolbar = new MenuWorkbenchToolBar(
		dom.window.document.body,
		menus,
		{
			showContextMenu(options) {
				shownOptions = options;
			},
		},
		menuId,
	);
	dom.window.document.body.append(toolbar.element);

	const buttons = toolbar.element.querySelectorAll("button");
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0]?.textContent, "Navigation");
	assert.equal(buttons[1]?.title, "More Actions");
	assert.equal(toolbar.element.textContent?.includes("Secondary"), false);
	buttons[1]?.click();
	assert.deepEqual(
		shownOptions?.getActions().map(({ id }) => id),
		["test.toolbar.secondary"],
	);
	assert.throws(
		() => toolbar.setActions([]),
		/actions are owned by its MenuId/,
	);

	toolbar.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("menu toolbar projects empty state as a stable visual class", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	const [
		{ MenuId, MenusRegistry },
		{ MenuService },
		{ CommandsRegistry },
		{ ContextKeyService },
		{ ServiceContainer },
		{ CommandService },
		{ DisposableStore },
		{ MenuWorkbenchToolBar },
	] = await Promise.all([
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/actions/common/menuService.js"),
		import("../../../../platform/commands/common/commands.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../workbench/services/commands/common/commandService.js"),
		import("../../../../base/common/lifecycle.js"),
		import("../../../../platform/actions/browser/toolbar.js"),
	]);
	using registrations = new DisposableStore();
	const menuId = new MenuId("test.toolbar.empty-state");
	const actionId = "test.toolbar.visible-action";
	registrations.add(CommandsRegistry.register(actionId, () => undefined));
	registrations.add(MenusRegistry.appendMenuItem(menuId, {
		command: { id: actionId, title: "Visible action" },
		group: "navigation",
		when: ContextKeyExpr.has("test.toolbar.visible"),
	}));
	const contexts = registrations.add(new ContextKeyService());
	const toolbar = new MenuWorkbenchToolBar(
		dom.window.document.body,
		new MenuService(new CommandService(new ServiceContainer()), contexts),
		{ showContextMenu() {} },
		menuId,
	);
	dom.window.document.body.append(toolbar.element);
	let menuChanges = 0;
	toolbar.onDidChangeMenuItems(() => menuChanges++);

	assert.equal(toolbar.element.hidden, true);
	assert.equal(toolbar.element.classList.contains("empty"), true);
	contexts.setContext("test.toolbar.visible", true);
	assert.equal(menuChanges, 1);
	assert.equal(toolbar.element.hidden, false);
	assert.equal(toolbar.element.classList.contains("empty"), false);
	contexts.setContext("test.toolbar.visible", false);
	assert.equal(menuChanges, 2);
	assert.equal(toolbar.element.hidden, true);
	assert.equal(toolbar.element.classList.contains("empty"), true);

	toolbar.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("menu toolbar retains action slots for enablement and toggle changes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	const [
		{ MenuId, MenusRegistry },
		{ MenuService },
		{ CommandsRegistry },
		{ ContextKeyService },
		{ ServiceContainer },
		{ CommandService },
		{ DisposableStore },
		{ MenuWorkbenchToolBar },
	] = await Promise.all([
		import("../../../../platform/actions/common/actions.js"),
		import("../../../../platform/actions/common/menuService.js"),
		import("../../../../platform/commands/common/commands.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../workbench/services/commands/common/commandService.js"),
		import("../../../../base/common/lifecycle.js"),
		import("../../../../platform/actions/browser/toolbar.js"),
	]);
	using registrations = new DisposableStore();
	const menuId = new MenuId("test.toolbar.retained-actions");
	const actionId = "test.toolbar.retained-action";
	registrations.add(CommandsRegistry.register(actionId, () => undefined));
	registrations.add(MenusRegistry.appendMenuItem(menuId, {
		command: {
			id: actionId,
			title: "Retained action",
			precondition: ContextKeyExpr.has("test.toolbar.ready"),
			toggled: ContextKeyExpr.has("test.toolbar.active"),
		},
		group: "navigation",
	}));
	const contexts = registrations.add(new ContextKeyService());
	const toolbar = new MenuWorkbenchToolBar(
		dom.window.document.body,
		new MenuService(new CommandService(new ServiceContainer()), contexts),
		{ showContextMenu() {} },
		menuId,
	);
	dom.window.document.body.append(toolbar.element);
	const slot = toolbar.element.querySelector<HTMLElement>(`[data-action-id='${actionId}']`);
	assert.ok(slot);

	contexts.setContext("test.toolbar.ready", true);
	assert.equal(toolbar.element.querySelector(`[data-action-id='${actionId}']`), slot);
	assert.equal(slot.querySelector("button")?.disabled, false);
	toolbar.focus();
	assert.equal(dom.window.document.activeElement, slot.querySelector("button"));

	contexts.setContext("test.toolbar.active", true);
	assert.equal(toolbar.element.querySelector(`[data-action-id='${actionId}']`), slot);
	assert.equal(slot.querySelector("button")?.classList.contains("checked"), true);
	toolbar.focus();
	assert.equal(dom.window.document.activeElement, slot.querySelector("button"));

	toolbar.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("More Actions opens an anchored Menu with actionable list items", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value: () => {},
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
		configurable: true,
		value: () => [{ width: 24, height: 24 }],
	});
	for (const [name, value] of Object.entries({
		window: dom.window,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
	})) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
	const [
		{ Separator },
		{ ToolBar },
		{ ContextKeyService },
		{ MenuService },
		{ ServiceContainer },
		{ CommandService },
		{ BrowserContextViewService },
		{ BrowserContextMenuService },
		{ BrowserNotificationService },
	] = await Promise.all([
		import("../../../../base/common/actions.js"),
		import("../../../../base/browser/ui/toolbar/toolbar.js"),
		import("../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../platform/actions/common/menuService.js"),
		import("../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../workbench/services/commands/common/commandService.js"),
		import("../../../../platform/contextview/browser/contextViewService.js"),
		import("../../../../platform/contextview/browser/contextMenuService.js"),
		import("../../../../platform/notification/browser/notificationService.js"),
	]);
	const host = dom.window.document.querySelector<HTMLElement>("main");
	assert.ok(host);
	using contexts = new ContextKeyService();
	const commands = new CommandService(new ServiceContainer());
	const menus = new MenuService(commands, contexts);
	using contextViews = new BrowserContextViewService(host);
	using notifications = new BrowserNotificationService(host);
	using contextMenus = new BrowserContextMenuService(
		menus,
		contexts,
		{
			inChordMode: false,
			onDidUpdateKeybindings: Event.None,
			resolveKeybinding() { throw new Error("Not used"); },
			resolveUserBinding() { return undefined; },
			lookupKeybindings() { return []; },
			lookupKeybinding() { return undefined; },
		},
		contextViews,
		notifications,
	);
	const openingOrder: string[] = [];
	contextMenus.onDidShowContextMenu(() => openingOrder.push("show"));
	host.addEventListener("focusin", (event) => {
		if ((event.target as HTMLElement).closest(".ash-menu")) openingOrder.push("focus");
	});
	let cleared = 0;
	using toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: contextMenus,
		moreActionsPlacement: { beforeActionId: "maximize" },
	});
	toolbar.setActions(
		[testAction("kill"), testAction("maximize"), testAction("close")],
		[
			testAction("clear", () => cleared++),
			new Separator(),
			{ ...testAction("output"), checked: true },
		],
	);
	host.append(toolbar.element);

	const more = toolbar.element.querySelector<HTMLButtonElement>("[data-action-id='ash.toolbar.moreActions'] button");
	assert.ok(more);
	more.click();

	const popup = host.querySelector<HTMLElement>(".ash-context-view .ash-menu");
	assert.ok(popup);
	assert.equal(popup.parentElement?.classList.contains("ash-context-view-menu"), true);
	assert.deepEqual(openingOrder, ["show", "focus"]);
	assert.equal(popup.getAttribute("role"), "menu");
	assert.deepEqual(
		[...popup.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemcheckbox']")]
			.map((item) => item.textContent),
		["clear", "output"],
	);
	assert.equal(popup.querySelectorAll(".ash-action-view-item-separator").length, 1);
	const popupItems = popup.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemcheckbox']");
	assert.equal(popupItems.length, 2);
	assert.equal([...popupItems].every((item) => item.querySelector(":scope > .ash-menu-leading-slot") !== null), true);
	const checkedPopupItem = popup.querySelector<HTMLElement>("[role='menuitemcheckbox']");
	assert.equal(checkedPopupItem?.getAttribute("aria-checked"), "true");
	assert.equal(checkedPopupItem?.querySelector(":scope > .ash-menu-leading-check") !== null, true);
	assert.equal(checkedPopupItem?.querySelector(":scope > .ash-menu-leading-check > .ash-icon") !== null, true);
	popup.querySelector<HTMLButtonElement>("[data-action-id='clear'] button")?.click();
	await Promise.resolve();
	assert.equal(cleared, 1);
	assert.equal(more.getAttribute("aria-expanded"), "false");

	toolbar.setActions([testAction("close")], [
		testAction("fail", async () => {
			await Promise.resolve();
			throw new Error("Action failed after the menu closed");
		}),
	]);
	const nextMore = toolbar.element.querySelector<HTMLButtonElement>(
		"[data-action-id='ash.toolbar.moreActions'] button",
	);
	assert.ok(nextMore);
	nextMore.click();
	host.querySelector<HTMLButtonElement>("[data-action-id='fail'] button")?.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(
		notifications.getNotifications()[0]?.message,
		"Action failed after the menu closed",
	);

	dom.window.close();
	for (const name of ["window", "Node", "Element", "HTMLElement"]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

function testAction(id: string, run: () => unknown = () => undefined) {
	return {
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run,
	};
}

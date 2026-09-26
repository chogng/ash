import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type {
	IContextMenuService,
} from "../../../../../../platform/contextview/browser/contextView.js";
import type {
	IMenubarControl,
} from "../../../../../../workbench/browser/parts/titlebar/menubarControl.js";
import type { ILocalizationService } from "../../../../../../workbench/services/localization/common/localizationService.js";
import { h } from "../../../../../../base/browser/dom.js";
import { Emitter, Event } from "../../../../../../base/common/event.js";
import { Lxicon } from "../../../../../../base/common/lxicons.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { DisposableStore } = await import(
	"../../../../../../base/common/lifecycle.js"
);
const { MenuId, MenusRegistry, IMenuService } = await import(
	"../../../../../../platform/actions/common/actions.js"
);
const { IContextMenuService: ContextMenuServiceId } = await import('../../../../../../platform/contextview/browser/contextView.js');
const { MenuService } = await import(
	"../../../../../../platform/actions/common/menuService.js"
);
const { CommandsRegistry, ICommandService } = await import(
	"../../../../../../platform/commands/common/commands.js"
);
const { ContextKeyService } = await import(
	"../../../../../../platform/contextkey/browser/contextKeyService.js"
);
const { ServiceContainer } = await import(
	"../../../../../../platform/instantiation/common/instantiation.js"
);
const { CommandService } = await import(
	"../../../../../../workbench/services/commands/common/commandService.js"
);
const { IQuickAccessController } = await import(
	"../../../../../../platform/quickinput/common/quickAccess.js"
);
const { BrowserTitlebarPart } = await import(
	"../../../../../../workbench/browser/parts/titlebar/titlebarPart.js"
);
const { BrowserMenubarControl } = await import(
	"../../../../../../workbench/browser/parts/titlebar/menubarControl.js"
);

const contextMenuService: IContextMenuService = {
	onDidShowContextMenu: Event.None,
	onDidHideContextMenu: Event.None,
	showContextMenu() {},
	hideContextMenu() {},
};

test("titlebar owns a menu-driven actions container", async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new ServiceContainer());
	const commandService = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() {} });
	const contextKeyService = disposables.add(new ContextKeyService());
	const menuService = new MenuService(commandService, contextKeyService);
	services.registerInstance(IMenuService, menuService);
	services.registerInstance(ContextMenuServiceId, contextMenuService);
	let runs = 0;
	const commandId = "test.titlebar.action";
	disposables.add(CommandsRegistry.register(commandId, () => {
		runs += 1;
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.TitleBar, {
		command: {
			id: commandId,
			title: "Title action",
		},
		group: "navigation",
	}));
	const menubarElement = h(ownerDocument, "nav");
	let menubarDisposed = false;
	const menubar: IMenubarControl = {
		domNode: menubarElement,
		dispose() {
			menubarDisposed = true;
			menubarElement.remove();
		},
		[Symbol.dispose]() {
			this.dispose();
		},
	};
	const titlebar = disposables.add(services.createInstance(BrowserTitlebarPart, ownerDocument.body, {
		menuService,
		contextMenuService,
	}, menubar));

	const actionsContainer = titlebar.domNode.querySelector(
		".ash-workbench-part-content > .ash-titlebar-actions",
	);
	assert.ok(actionsContainer);
	assert.equal(actionsContainer.classList.contains("ash-titlebar-interactive-region"), true);
	assert.equal(
		actionsContainer.querySelector(".ash-action-bar")
			?.getAttribute("role"),
		"toolbar",
	);
	assert.equal(
		actionsContainer.querySelector(".ash-toolbar")
			?.classList.contains("ash-toolbar-inherit-foreground"),
		true,
	);
	assert.equal(
		actionsContainer.querySelector(".ash-action-bar")
			?.classList.contains("highlight-toggled"),
		false,
	);
	assert.equal(menubarElement.classList.contains("ash-titlebar-interactive-region"), true);

	const button = actionsContainer.querySelector<HTMLButtonElement>('[data-action-id="test.titlebar.action"] button');
	assert.equal(button?.textContent, "Title action");
	button?.click();
	await Promise.resolve();
	assert.equal(runs, 1);

	const secondMenuRegistration = disposables.add(
		MenusRegistry.appendMenuItem(MenuId.TitleBar, {
			command: {
				id: commandId,
				title: "Second title action",
			},
			group: "navigation",
			order: 20,
		}),
	);
	assert.deepEqual(
		[...actionsContainer.querySelectorAll('[data-action-id="test.titlebar.action"] button')]
			.map((element) => element.textContent),
		["Title action", "Second title action"],
	);

	secondMenuRegistration.dispose();
	titlebar.dispose();
	assert.equal(titlebar.domNode.isConnected, false);
	assert.equal(menubarDisposed, true);
});

test("titlebar renders its product icon, command center, and application menu", () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new ServiceContainer());
	const commandService = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() {} });
	const contextKeyService = disposables.add(new ContextKeyService());
	const menuService = new MenuService(commandService, contextKeyService);
	services.registerInstance(IMenuService, menuService);
	services.registerInstance(ContextMenuServiceId, contextMenuService);
	const localeChanged = disposables.add(new Emitter<void>());
	let commandCenterLabel = "Search commands";
	const localizationService: ILocalizationService = {
		onDidChange: localeChanged.event,
		whenReady: Promise.resolve(),
		translate: (_bundle, key, fallback) => key === "searchCommands" ? commandCenterLabel : fallback,
	};
	disposables.add(MenusRegistry.appendMenuItem(MenuId.TitleBarLeft, {
		command: {
			id: "test.titlebar.leftAction",
			title: "Left title action",
		},
		group: "navigation",
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.CommandCenter, {
		command: { id: 'test.titlebar.back', title: 'Go Back' },
		group: 'navigation',
		order: 1,
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.CommandCenter, {
		command: { id: 'test.titlebar.forward', title: 'Go Forward' },
		group: 'navigation',
		order: 2,
	}));
	const menubar = new BrowserMenubarControl(ownerDocument.body, menuService, contextMenuService);
	const titlebar = disposables.add(services.createInstance(BrowserTitlebarPart, ownerDocument.body, {
		menuService,
		contextMenuService,
		localizationService,
	}, menubar));

	const titleChildren = [...titlebar.domNode.querySelector(
		".ash-workbench-part-title",
	)?.children ?? []];
	assert.equal(
		titleChildren[0]?.classList.contains("ash-titlebar-app-icon"),
		true,
	);
	assert.equal(titleChildren[0]?.getAttribute("aria-hidden"), "true");
	assert.equal(titleChildren[1], menubar.domNode);
	assert.equal(
		titleChildren[1]?.classList.contains("ash-titlebar-left-actions"),
		true,
	);
	assert.equal(
		titleChildren[1]?.querySelector('[data-action-id="test.titlebar.leftAction"] button')?.textContent,
		"Left title action",
	);
	assert.equal(titleChildren.length, 2);
	assert.equal(titlebar.domNode.querySelector(".ash-titlebar-label"), null);
	const commandCenter = titlebar.domNode.querySelector<HTMLButtonElement>(".ash-titlebar-command-center-button");
	const navigation = titlebar.domNode.querySelector('.ash-titlebar-command-center-navigation');
	assert.deepEqual([...navigation?.querySelectorAll('button') ?? []].map(button => button.textContent), ['Go Back', 'Go Forward']);
	assert.equal(navigation?.nextElementSibling, commandCenter);
	assert.equal(commandCenter?.textContent, "Search commands");
	assert.equal(commandCenter?.getAttribute("aria-label"), "Search commands");
	assert.equal(commandCenter?.type, "button");
	assert.equal(commandCenter?.getAttribute('aria-haspopup'), 'dialog');
	assert.equal(commandCenter?.getAttribute('aria-expanded'), 'false');
	assert.equal(commandCenter?.closest(".ash-titlebar-center")?.previousElementSibling?.className, "ash-workbench-part-title");
	assert.equal(commandCenter?.closest(".ash-titlebar-center")?.nextElementSibling?.className, "ash-workbench-part-content");
	commandCenterLabel = "搜索命令";
	localeChanged.fire();
	assert.equal(commandCenter?.textContent, "搜索命令");
	assert.equal(commandCenter?.getAttribute("aria-label"), "搜索命令");
});

test("browser titlebar hosts the application menu in an ActionBar", () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const commandService = disposables.add(
		new CommandService(new ServiceContainer()),
	);
	const contextKeyService = disposables.add(new ContextKeyService());
	const menuService = new MenuService(commandService, contextKeyService);
	const fileMenu = new MenuId("test.titlebar.file");
	const emptyEditMenu = new MenuId("test.titlebar.edit");
	disposables.add(MenusRegistry.appendMenuItem(fileMenu, {
		command: { id: "test.titlebar.newFile", title: "New File" },
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
		title: "File",
		submenu: fileMenu,
		group: "navigation",
		order: 1,
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
		title: "Edit",
		submenu: emptyEditMenu,
		group: "navigation",
		order: 2,
	}));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.TitleBarLeft, {
		command: {
			id: "test.titlebar.toggleSidebar",
			title: "Toggle sidebar",
			icon: Lxicon.layoutSidebarLeft,
		},
		group: "navigation",
	}));

	let menuLabels: readonly string[] = [];
	let openSubmenusImmediatelyOnHover: boolean | undefined;
	const menuContextService: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(options) {
			menuLabels = options.getActions?.().map((action) => action.label) ?? [];
			openSubmenusImmediatelyOnHover = options.openSubmenusImmediatelyOnHover;
		},
		hideContextMenu() {},
	};
	const localeChanged = disposables.add(new Emitter<void>());
	let applicationMenuLabel = "Application menu";
	const localizationService: ILocalizationService = {
		onDidChange: localeChanged.event,
		whenReady: Promise.resolve(),
		translate: (_bundle, key, fallback) => key === "applicationMenu" ? applicationMenuLabel : fallback,
	};
	const menubar = disposables.add(new BrowserMenubarControl(
		ownerDocument.body,
		menuService,
		menuContextService,
		localizationService,
	));

	const button = menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button');
	const sidebarButton = menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="test.titlebar.toggleSidebar"] button');
	assert.ok(button);
	assert.ok(sidebarButton);
	assert.equal(menubar.domNode.classList.contains("ash-action-bar"), true);
	assert.equal(menubar.domNode.classList.contains("ash-toolbar"), true);
	assert.equal(button.closest(".ash-action-view-item")?.classList.contains("icon"), true);
	assert.equal(menubar.domNode.getAttribute("role"), "toolbar");
	assert.equal(menubar.domNode.getAttribute("aria-label"), "Title bar left actions");
	assert.equal(button.closest(".ash-action-view-item")?.parentElement, menubar.domNode);
	assert.equal(sidebarButton.closest(".ash-action-view-item")?.parentElement, menubar.domNode);
	assert.equal(button.tabIndex, 0);
	assert.equal(button.title, "Application menu");
	assert.ok(button.querySelector(".ash-icon"));
	assert.equal(menubar.domNode.querySelectorAll("button").length, 2);

	button.focus();
	button.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", {
		key: "ArrowRight",
		bubbles: true,
		cancelable: true,
	}));
	assert.equal(ownerDocument.activeElement, sidebarButton);
	sidebarButton.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", {
		key: "ArrowLeft",
		bubbles: true,
		cancelable: true,
	}));
	assert.equal(ownerDocument.activeElement, button);
	applicationMenuLabel = "应用程序菜单";
	localeChanged.fire();
	assert.equal(button.getAttribute("aria-label"), applicationMenuLabel);
	const extraAction = disposables.add(MenusRegistry.appendMenuItem(MenuId.TitleBarLeft, {
		command: { id: "test.titlebar.extra", title: "Extra action" },
		group: "navigation",
		order: 20,
	}));
	const updatedButton = menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button');
	assert.ok(updatedButton);
	assert.notEqual(updatedButton, button);
	assert.equal(ownerDocument.activeElement, updatedButton);
	assert.equal(updatedButton.getAttribute("aria-label"), applicationMenuLabel);
	updatedButton.dispatchEvent(new browserEnvironment.window.KeyboardEvent("keydown", {
		key: "ArrowDown",
		bubbles: true,
		cancelable: true,
	}));
	assert.deepEqual(menuLabels, ["File"]);
	assert.equal(openSubmenusImmediatelyOnHover, true);
	assert.equal(updatedButton.getAttribute("aria-expanded"), "true");
	extraAction.dispose();
});

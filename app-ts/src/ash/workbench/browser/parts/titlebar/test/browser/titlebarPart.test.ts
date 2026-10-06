import type { IEditorGroup, IEditorGroupsContainer } from '../../../../../services/editor/common/editorGroupsService.js';
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
const { InstantiationService } = await import(
	'../../../../../../platform/instantiation/common/instantiationService.js'
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
const { BrowserTitleService, createBrowserTitlebarPart } = await import('../../titlebarPart.js');
const { ITitleService } = await import('../../../../../services/title/browser/titleService.js');
const { IEditorService } = await import('../../../../../services/editor/common/editorService.js');
const { IWorkingCopyService } = await import('../../../../../services/workingCopy/common/workingCopyService.js');
const { BrowserWorkingCopyService } = await import('../../../../../services/workingCopy/browser/browserWorkingCopyService.js');
const { IWorkspaceContextService } = await import('../../../../../../platform/workspace/common/workspace.js');
const { WorkspaceContextService } = await import('../../../../../services/workspaces/browser/workspaceContextService.js');
const { ILabelService, LabelService } = await import('../../../../../../platform/label/common/labelService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../../services/localization/common/localizationService.js');
const { IConfigurationService } = await import('../../../../../../platform/configuration/common/configuration.js');
const { InMemoryConfigurationService } = await import('../../../../../../platform/configuration/common/inMemoryConfigurationService.js');
const { IContextKeyService } = await import('../../../../../../platform/contextkey/common/contextkey.js');
const { DebugTitleContribution } = await import('../../../../../contrib/debug/browser/debugTitle.js');
const { IDebugService } = await import('../../../../../services/debug/common/debugService.js');
const { IHostService } = await import('../../../../../services/host/browser/host.js');
const { URI } = await import('../../../../../../base/common/uri.js');
const { BrowserMenubarControl } = await import(
	"../../../../../../workbench/browser/parts/titlebar/menubarControl.js"
);

const contextMenuService: IContextMenuService = {
	onDidShowContextMenu: Event.None,
	onDidHideContextMenu: Event.None,
	showContextMenu() { },
	hideContextMenu() { },
};

test('host focus follows registered windows without publishing a false blur during a handoff', async () => {
	using resources = new DisposableStore();
	const { BrowserHostService } = await import('../../../../../services/host/browser/browserHostService.js');
	const { ILifecycleService } = await import('../../../../../services/lifecycle/common/lifecycle.js');
	const { registerWindow } = await import('../../../../../../base/browser/window.js');
	const { toDisposable } = await import('../../../../../../base/common/lifecycle.js');
	const main = browserEnvironment.window;
	const popup = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => popup.window.close()));
	let mainFocused = true;
	let popupFocused = false;
	Object.defineProperty(main.document, 'hasFocus', { configurable: true, value: () => mainFocused });
	Object.defineProperty(popup.window.document, 'hasFocus', { configurable: true, value: () => popupFocused });
	resources.add(toDisposable(() => Reflect.deleteProperty(main.document, 'hasFocus')));
	const services = resources.add(new InstantiationService());
	services.registerInstance(ILifecycleService, {} as import('../../../../../services/lifecycle/common/lifecycle.js').ILifecycleService);
	const host = resources.add(services.createInstance(BrowserHostService));
	resources.add(registerWindow(popup.window as unknown as Window));
	const changes: boolean[] = [];
	resources.add(host.onDidChangeFocus(value => changes.push(value)));
	mainFocused = false;
	main.dispatchEvent(new main.Event('blur'));
	popupFocused = true;
	popup.window.dispatchEvent(new popup.window.Event('focus'));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(host.hasFocus, true);
	assert.deepEqual(changes, []);
	popupFocused = false;
	popup.window.dispatchEvent(new popup.window.Event('blur'));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(host.hasFocus, false);
	assert.deepEqual(changes, [false]);
	host.dispose();
	mainFocused = true;
	main.dispatchEvent(new main.Event('focus'));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(changes, [false]);
});

test('title service shares the resolved title with its registered part and releases both', async () => {
	using resources = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const services = resources.add(new InstantiationService());
	const commandService = resources.add(new CommandService(services));
	const contextKeys = resources.add(new ContextKeyService());
	const workspace = resources.add(new WorkspaceContextService({ id: 'title-service', folders: [] }));
	const activeChanged = resources.add(new Emitter<void>());
	let activeEditor: import('../../../../../common/editor.js').IResourceEditorInput | undefined;
	const editors: import('../../../../../services/editor/common/editorService.js').IEditorService = {
		get activeEditor() { return activeEditor; },
		visibleEditors: [],
		onDidActiveEditorChange: activeChanged.event,
		onDidVisibleEditorsChange: Event.None,
		async openEditor(input) { activeEditor = input; activeChanged.fire(); },
		focusActiveEditor() { },
	};
	const groups: IEditorGroupsContainer = {
		activeGroup: {
			get activeInput() { return activeEditor; },
			onDidChangeEditors: listener => activeChanged.event(() => listener({ kind: 'activeEditorChanged', editor: undefined })),
		} as IEditorGroup,
		onDidChangeActiveGroup: Event.None,
	};
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IMenuService, new MenuService(commandService, contextKeys));
	services.registerInstance(ContextMenuServiceId, contextMenuService);
	services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() { } });
	services.registerInstance(LocalizationServiceId, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	services.registerInstance(IEditorService, editors);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkingCopyService, resources.add(new BrowserWorkingCopyService()));
	services.registerInstance(ILabelService, resources.add(new LabelService(workspace)));
	services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
	services.registerInstance(IContextKeyService, contextKeys);
	const titleService = resources.add(services.createInstance(BrowserTitleService, ownerDocument.body, 'Ash Code', createBrowserTitlebarPart, groups));
	services.registerInstance(ITitleService, titleService);
	const shared = services.get(ITitleService);
	const part = titleService.getPart(ownerDocument.body);
	assert.equal(shared, titleService);
	assert.equal(shared.getPart(part.domNode), part);
	assert.equal(ownerDocument.querySelectorAll('[data-part="titlebar"]').length, 1);
	const center = part.domNode.querySelector<HTMLButtonElement>('.ash-titlebar-command-center-button')!;
	await editors.openEditor({ resource: URI.file('/draft.ts') });
	workspace.updateWorkspace({ id: 'project', folders: [], name: '研究项目' });
	assert.deepEqual([shared.windowTitle.value, center.title, center.getAttribute('aria-description')], Array(3).fill('draft.ts — 研究项目 — Ash Code'));
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue('window.title', '${branch}${separator}${activeEditorShort}${separator}${appName}');
	contextKeys.setContext('title.branch', 'main');
	await commandService.executeCommand('registerWindowTitleVariable', 'branch', 'title.branch');
	assert.equal(shared.windowTitle.value, 'main — draft.ts — Ash Code');
	const popup = new JSDOM('<!doctype html><body></body>');
	const popupChanged = resources.add(new Emitter<void>());
	let popupInput = { resource: URI.file('/detached.ts') };
	const popupGroups: IEditorGroupsContainer = {
		activeGroup: {
			get activeInput() { return popupInput; },
			onDidChangeEditors: listener => popupChanged.event(() => listener({ kind: 'activeEditorChanged', editor: undefined })),
		} as IEditorGroup,
		onDidChangeActiveGroup: Event.None,
	};
	const auxiliary = shared.createAuxiliaryTitlebarPart(popup.window.document.body, popupGroups, services);
	assert.equal(shared.getPart(auxiliary.container), auxiliary);
	assert.equal(popup.window.document.title, 'main — detached.ts — Ash Code');
	assert.throws(() => shared.createAuxiliaryTitlebarPart(popup.window.document.body, popupGroups, services), /already has a titlebar/);
	shared.updateProperties({ prefix: '🔴' });
	contextKeys.setContext('title.branch', 'feature');
	assert.equal(shared.windowTitle.value, '🔴 feature — draft.ts — Ash Code');
	assert.equal(popup.window.document.title, '🔴 feature — detached.ts — Ash Code');
	popupInput = { resource: URI.file('/other.ts') };
	popupChanged.fire();
	assert.equal(shared.windowTitle.value, '🔴 feature — draft.ts — Ash Code');
	assert.equal(popup.window.document.title, '🔴 feature — other.ts — Ash Code');
	const visibility: boolean[] = [];
	resources.add(auxiliary.onMenubarVisibilityChange(value => visibility.push(value)));
	auxiliary.updateOptions({ compact: true });
	assert.equal(auxiliary.container.classList.contains('ash-auxiliary-titlebar-compact'), true);
	auxiliary.updateOptions({ compact: false });
	assert.deepEqual(visibility, [false, true]);
	auxiliary.dispose();
	assert.equal(auxiliary.container.isConnected, false);
	assert.equal(popupChanged.hasListeners(), false);
	assert.throws(() => shared.getPart(popup.window.document.body), /no titlebar registered/);
	popup.window.close();
	const sessionStateChanged = resources.add(new Emitter<import('../../../../../services/debug/common/debugService.js').DebugSessionState>());
	let state: import('../../../../../services/debug/common/debugService.js').DebugSessionState = 'running';
	let focused = false;
	const focusChanged = resources.add(new Emitter<boolean>());
	services.registerInstance(IHostService, {
		get hasFocus() { return focused; },
		onDidChangeFocus: focusChanged.event,
		async restart() { }, async openWindow() { },
	});
	services.registerInstance(IDebugService, {
		session: { get state() { return state; }, onDidChangeState: sessionStateChanged.event },
		onDidChangeSession: Event.None,
	} as import('../../../../../services/debug/common/debugService.js').IDebugService);
	const debugTitle = services.createInstance(DebugTitleContribution);
	state = 'stopped';
	sessionStateChanged.fire(state);
	assert.equal(shared.windowTitle.value, '🔴 feature — draft.ts — Ash Code');
	focused = true;
	focusChanged.fire(true);
	assert.equal(shared.windowTitle.value, 'feature — draft.ts — Ash Code');
	focused = false;
	focusChanged.fire(false);
	state = 'running';
	sessionStateChanged.fire(state);
	assert.equal(shared.windowTitle.value, 'feature — draft.ts — Ash Code');
	debugTitle.dispose();
	assert.equal(focusChanged.hasListeners(), false);
	assert.equal(sessionStateChanged.hasListeners(), false);
	const otherDocument = ownerDocument.implementation.createHTMLDocument();
	assert.throws(() => shared.getPart(otherDocument.body), /no titlebar registered/);
	titleService.dispose();
	assert.equal(part.domNode.isConnected, false);
	assert.equal(activeChanged.hasListeners(), false);
	ownerDocument.title = 'Next owner';
	await editors.openEditor({ resource: URI.file('/next.ts') });
	assert.equal(ownerDocument.title, 'Next owner');
});

test('title service rejects assembly without its required workspace service', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(BrowserTitleService, browserEnvironment.window.document.body, 'Ash Code', createBrowserTitlebarPart, {} as IEditorGroupsContainer), /Unknown service: workspaceContextService/);
});

test("titlebar owns a menu-driven actions container", async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new InstantiationService());
	const commandService = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() { } });
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
	services.registerInstance(LocalizationServiceId, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	const titlebar = disposables.add(services.createInstance(BrowserTitlebarPart, ownerDocument.body, {
		windowTitle: { value: 'Ash Code', onDidChange: Event.None, updateProperties() { }, registerVariables() { } },
		menuService,
		contextMenuService,
		localizationService: { whenReady: Promise.resolve(), translate: (_bundle: string, _key: string, fallback: string) => fallback },
	}, () => menubar));

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
	const services = disposables.add(new InstantiationService());
	const commandService = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() { } });
	const contextKeyService = disposables.add(new ContextKeyService());
	const menuService = new MenuService(commandService, contextKeyService);
	services.registerInstance(IMenuService, menuService);
	services.registerInstance(ContextMenuServiceId, contextMenuService);
	const localeChanged = disposables.add(new Emitter<void>());
	let commandCenterLabel = "Search commands";
	const localizationService: ILocalizationService = {
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
	const titleChanged = disposables.add(new Emitter<void>());
	const windowTitle = { value: '研究项目 — Ash Code', onDidChange: titleChanged.event };
	services.registerInstance(LocalizationServiceId, localizationService);
	const titlebar = disposables.add(services.createInstance(BrowserTitlebarPart, ownerDocument.body, {
		windowTitle,
	}, () => menubar));

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
	assert.equal(commandCenter?.title, windowTitle.value);
	assert.equal(commandCenter?.getAttribute('aria-description'), windowTitle.value);
	windowTitle.value = '● 草稿.ts — 研究项目 — Ash Code';
	titleChanged.fire();
	assert.equal(commandCenter?.title, windowTitle.value);
	assert.equal(commandCenter?.getAttribute('aria-description'), windowTitle.value);
	assert.equal(commandCenter?.type, "button");
	assert.equal(commandCenter?.getAttribute('aria-haspopup'), 'dialog');
	assert.equal(commandCenter?.getAttribute('aria-expanded'), 'false');
	assert.equal(commandCenter?.closest(".ash-titlebar-center")?.previousElementSibling?.className, "ash-workbench-part-title");
	assert.equal(commandCenter?.closest(".ash-titlebar-center")?.nextElementSibling?.className, "ash-workbench-part-content");
	commandCenterLabel = "搜索命令";
	localeChanged.fire();
	assert.equal(commandCenter?.textContent, "Search commands");
	assert.equal(commandCenter?.getAttribute("aria-label"), "Search commands");
	titlebar.dispose();
	assert.equal(titleChanged.hasListeners(), false);
});

test("browser titlebar hosts the application menu in an ActionBar", () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const commandService = disposables.add(
		new CommandService(new InstantiationService()),
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
			icon: Lxicon.layoutSidebarLeft1,
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
		hideContextMenu() { },
	};
	const applicationMenuLabel = "Application menu";
	const localizationService: ILocalizationService = {
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
	assert.equal(sidebarButton.getAttribute("aria-label"), "Toggle sidebar");
	assert.ok(sidebarButton.querySelector(".ash-icon"));
	assert.equal(sidebarButton.closest(".ash-action-view-item")?.classList.contains("icon"), true);
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
	assert.equal(button.getAttribute("aria-label"), "Application menu");
	const extraAction = disposables.add(MenusRegistry.appendMenuItem(MenuId.TitleBarLeft, {
		command: { id: "test.titlebar.extra", title: "Extra action" },
		group: "navigation",
		order: 20,
	}));
	const updatedButton = menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button');
	assert.ok(updatedButton);
	assert.equal(updatedButton, button);
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
	menubar.setTrailingActions([{ id: 'test.titlebar.back', label: 'Back', tooltip: 'Back', icon: Lxicon.arrowLeft, enabled: true, run() { } }]);
	assert.deepEqual(
		Array.from(menubar.domNode.querySelectorAll<HTMLButtonElement>('button'), item => item.getAttribute('aria-label')),
		[applicationMenuLabel, 'Toggle sidebar', 'Back'],
	);
});

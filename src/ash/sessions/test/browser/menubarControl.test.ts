import { createLabelKeybindingService } from '../../../platform/keybinding/test/common/keybindingTestUtils.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { SubmenuAction, type IAction } from '../../../base/common/actions.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { IMenuService, MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { BrowserMenubarControl } from '../../../workbench/browser/parts/titlebar/menubarControl.js';
import { NativeMenubarControl } from '../../../workbench/electron-browser/parts/titlebar/menubarControl.js';
import type { INativeMenubarData, INativeMenubarSelection } from '../../../platform/menubar/common/nativeMenubar.js';
import { Menus } from '../../browser/menus.js';
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../../common/windowNavigation.js';
import { TestNotificationService } from '../../../workbench/services/notification/test/common/testNotificationService.js';

test('Sessions and Workbench menus keep product commands separate while sharing menu interaction', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using services = new InstantiationService();
	using commands = new CommandService(services);
	using contextKeys = new ContextKeyService();
	const menus = new MenuService(commands, contextKeys);
	await import('../../browser/parts/menubar.contribution.js');
	let commandRuns = 0;
	let didRun: (() => void) | undefined;
	using command = CommandsRegistry.register('test.sessions.menubar.command', () => { commandRuns++; didRun?.(); });
	using fileCommand = MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, { command: { id: 'test.sessions.menubar.command', title: 'Selected command' } });
	using workbenchFile = MenusRegistry.appendMenuItem(MenuId.MenubarMainMenu, { title: 'File', submenu: MenuId.MenubarFileMenu });
	using workbenchCommand = MenusRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: 'test.workbench.command', title: 'Workbench command' } });
	using returnCommand = CommandsRegistry.register(RETURN_TO_WORKBENCH_COMMAND_ID, () => { commandRuns++; didRun?.(); });
	using runCommand = MenusRegistry.appendMenuItem(MenuId.MenubarRunMenu, { command: { id: 'test.sessions.menubar.command', title: 'Excluded command' } });
	const contextMenus: IContextMenuService = {
		contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
		showContextMenu() { throw new Error('Application menus must use Base MenuBar'); }, hideContextMenu() { },
	};
	services.registerInstance(IMenuService, menus);
	services.registerInstance(IContextMenuService, contextMenus);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	services.registerInstance(IKeybindingService, createLabelKeybindingService());
	using menuNotifications = new TestNotificationService();
	services.registerInstance(INotificationService, menuNotifications);
	using menubar = services.createInstance(BrowserMenubarControl, browser.window.document.body, { applicationMenuId: Menus.MenubarMainMenu, titlebarMenuId: Menus.TitleBarLeftLayout });
	using workbenchMenubar = services.createInstance(BrowserMenubarControl, browser.window.document.body, {});
	const menuButton = (): HTMLButtonElement => menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!;
	const categoryLabels = (): (string | null)[] => [...browser.window.document.querySelectorAll('.ash-context-view-menu:not([hidden]) > .ash-menu > .ash-action-view-item > button')].map(button => button.textContent);
	const openFile = (control: BrowserMenubarControl): void => {
		control.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!.click();
		browser.window.document.querySelector<HTMLButtonElement>('[data-action-id="menubar.0"] button')!.click();
	};
	const execute = async (id: string): Promise<void> => {
		const completed = new Promise<void>(resolve => { didRun = resolve; });
		browser.window.document.querySelector<HTMLButtonElement>(`[data-action-id="${id}"] button`)!.click();
		await completed;
	};
	try {
		menuButton().click();
		assert.deepEqual(categoryLabels(), ['File']);
		menuButton().click();
		openFile(menubar);
		assert.equal(browser.window.document.querySelector('[data-action-id="test.workbench.command"]'), null);
		await execute('test.sessions.menubar.command');
		openFile(menubar);
		await execute(RETURN_TO_WORKBENCH_COMMAND_ID);
		assert.equal(commandRuns, 2);
		openFile(workbenchMenubar);
		assert.ok(browser.window.document.querySelector('[data-action-id="test.workbench.command"]'));
		assert.equal(browser.window.document.querySelector('[data-action-id="test.sessions.menubar.command"]'), null);
		workbenchMenubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!.click();
		{
			using failing = CommandsRegistry.register('test.sessions.menubar.failure', async () => { throw new Error('Menu command failed'); });
			using failureItem = MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, { command: { id: 'test.sessions.menubar.failure', title: 'Fail command' } });
			let reported: (() => void) | undefined;
			const notified = new Promise<void>(resolve => { reported = resolve; });
			using notification = menuNotifications.model.onDidAdd(item => {
				assert.equal(item.message, 'Menu command failed');
				reported?.();
			});
			openFile(menubar);
			browser.window.document.querySelector<HTMLButtonElement>('[data-action-id="test.sessions.menubar.failure"] button')!.click();
			assert.equal(browser.window.document.querySelector('.ash-context-view-menu:not([hidden])'), null);
			await notified;
		}
		menuButton().click();
		using helpCommand = MenusRegistry.appendMenuItem(MenuId.MenubarHelpMenu, { command: { id: 'test.sessions.menubar.command', title: 'Help command' } });
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		menuButton().click();
		assert.deepEqual(categoryLabels(), ['File', 'Help']);
		menubar.setTrailingActions([{ id: 'test.sessions.menubar.toggle', label: 'Toggle', tooltip: 'Toggle', enabled: true, checked: true, run() { } }]);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		assert.deepEqual([...menubar.domNode.querySelectorAll('button')].map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')]), [['Application menu', null], ['Toggle', 'true']]);
		using selections = new Emitter<INativeMenubarSelection>();
		using resources = new DisposableStore();
		using notifications = new TestNotificationService();
		const published = new Promise<INativeMenubarData>(resolve => {
			resources.add(new NativeMenubarControl(Menus.MenubarMainMenu, {
				_serviceBrand: undefined,
				async updateMenubar(data) { resolve(data); },
				onDidSelect: listener => selections.event(listener),
			}, menus, notifications));
		});
		const data = await published;
		const items = data.menus.find(menu => menu.label === 'File')!.items;
		assert.deepEqual(items.filter(item => item.type === 'action').map(item => item.label), ['Return to Workbench', 'Selected command']);
		const selected = items.find(item => item.type === 'action' && item.label === 'Selected command')!;
		assert.ok(selected.type === 'action');
		selections.fire({ revision: data.revision, id: selected.id });
		assert.equal(commandRuns, 3);
		resources.dispose();
		assert.equal(selections.hasListeners(), false);
	} finally {
		menubar.dispose();
		browser.window.close();
	}
});

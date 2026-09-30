import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../base/common/event.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { TitlebarPart } from '../../browser/parts/titlebar/titlebarPart.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

test('Sessions titlebar localizes its actions and closes the application menu before refreshing or disposal', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using changed = new Emitter<void>();
	using contextKeys = new ContextKeyService();
	using services = new ServiceContainer();
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	using fileCommand = MenusRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: 'test.sessions.titlebar', title: 'Test command' } });
	using fileMenu = MenusRegistry.appendMenuItem(MenuId.MenubarMainMenu, { title: 'File', submenu: MenuId.MenubarFileMenu });
	let onHide: (() => void) | undefined;
	let closedMenus = 0;
	const contextMenus: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			onHide = () => delegate.onHide?.(false);
			assert.deepEqual(delegate.getActions?.().map(action => action.label), ['File']);
		},
		hideContextMenu() {
			closedMenus++;
			onHide?.();
			onHide = undefined;
		},
	};
	const sessions: ISessionsService = {
		onDidChange: changed.event,
		visibleSelections: [],
		activeSelection: undefined,
		canNavigateBack: false,
		canNavigateForward: false,
		async initialize() {},
		openSession() {},
		openUntitledSession() {},
		openNewSession() { throw new Error('This scenario does not create sessions'); },
		activateSelection() {},
		closeVisibleSelection() {},
		navigateBack() {},
		navigateForward() {},
	};
	const titlebar = new TitlebarPart(browser.window.document.body, sessions, menus, contextMenus, { toggleSidebar() {} });
	const menuButton = (): HTMLButtonElement => titlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!;
	try {
		menuButton().click();
		assert.equal(menuButton().getAttribute('aria-expanded'), 'true');
		changed.fire();
		assert.equal(closedMenus, 1);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		menuButton().click();
		setNlsResolver((bundle, key, fallback) => {
			if (bundle === 'ash.regions' && key === 'applicationMenu') { return '应用程序菜单'; }
			if (bundle === 'ash.regions' && key === 'titleBarLeftActions') { return '标题栏左侧操作'; }
			if (key === 'sessions.navigation.hideSidebar') { return '隐藏侧栏'; }
			return fallback;
		});
		assert.equal(closedMenus, 2);
		assert.deepEqual([...titlebar.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['应用程序菜单', '隐藏侧栏', 'Back', 'Forward']);
		assert.equal(titlebar.domNode.querySelector('[role="toolbar"]')?.getAttribute('aria-label'), '标题栏左侧操作');
		menuButton().click();
		titlebar.dispose();
		assert.equal(closedMenus, 3);
		assert.equal(changed.hasListeners(), false);
		assert.equal(browser.window.document.body.childElementCount, 0);
	} finally {
		titlebar.dispose();
		resetNlsResolver();
		browser.window.close();
	}
});

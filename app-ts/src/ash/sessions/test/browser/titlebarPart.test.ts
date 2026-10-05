import '../../../editor/test/browser/testEditorDom.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { sessionsPartIds, type SessionsPartId } from '../../common/layoutConstants.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Dimension } from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { IMenuService, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { WorkbenchPart } from '../../../workbench/browser/part.js';
import { registerLayoutActions } from '../../browser/layoutActions.js';
import { SessionsWorkbenchLayout } from '../../browser/workbench.js';
import { Menus } from '../../browser/menus.js';
import { TitlebarPart } from '../../browser/parts/titlebar/titlebarPart.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

class TestPart extends WorkbenchPart {
	public getTabsHeight(): number { return 35; }
	public setContentRightInset(_inset: number): void {}
	public setEditorContentVisible(_visible: boolean): void {}
	constructor(container: HTMLElement, id: SessionsPartId) { super(container, id); }
}

test('Sessions titlebar initializes localized actions and closes the application menu before refreshing or disposal', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using changed = new Emitter<void>();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	using resources = new DisposableStore();
	using fileCommand = MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, { command: { id: 'test.sessions.titlebar', title: 'Test command' } });
	using fileMenu = MenusRegistry.appendMenuItem(Menus.MenubarMainMenu, { title: 'File', submenu: Menus.MenubarFileMenu });
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
		getSelection() { return { visibleSelections: [], activeSelection: undefined }; },
		async openThread() {},
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
	setNlsResolver((bundle, key, fallback) => {
		if (bundle === 'ash.regions' && key === 'applicationMenu') { return '应用程序菜单'; }
		if (bundle === 'ash.regions' && key === 'titleBarLeftActions') { return '标题栏左侧操作'; }
		if (key === 'sessions.navigation.hideSidebar') { return '隐藏侧栏'; }
		return fallback;
	});
	services.registerInstance(IMenuService, menus);
	services.registerInstance(IContextMenuService, contextMenus);
	const titlebar = services.createInstance(TitlebarPart, browser.window.document.body, 'application-menu');
	const parts = new Map<SessionsPartId, WorkbenchPart>(sessionsPartIds.map(id => [id, id === 'titlebar' ? titlebar : resources.add(new TestPart(browser.window.document.body, id))]));
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	using actions = registerLayoutActions(layout, sessions, contextKeys);
	const menuButton = (): HTMLButtonElement => titlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!;
	try {
		menuButton().click();
		assert.equal(menuButton().getAttribute('aria-expanded'), 'true');
		changed.fire();
		assert.equal(closedMenus, 0);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'true');
		layout.hidePart('sidebar');
		assert.equal(closedMenus, 1);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		layout.showPart('sidebar');
		menuButton().click();

		assert.equal(closedMenus, 1);
		assert.deepEqual([...titlebar.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['应用程序菜单', '隐藏侧栏', 'Back', 'Forward', 'Toggle Code panel']);
		assert.equal(titlebar.domNode.querySelector('[role="toolbar"]')?.getAttribute('aria-label'), '标题栏左侧操作');
		titlebar.dispose();
		assert.equal(closedMenus, 2);
		using systemMenuTitlebar = services.createInstance(TitlebarPart, browser.window.document.body, 'actions-only');
		assert.deepEqual([...systemMenuTitlebar.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['隐藏侧栏', 'Back', 'Forward', 'Toggle Code panel']);
		const sidebarToggle = systemMenuTitlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.sessions.toggleSidebar"] button')!;
		sidebarToggle.click();
		assert.equal(systemMenuTitlebar.domNode.querySelector('[data-action-id="ash.sessions.toggleSidebar"] button')!.getAttribute('aria-pressed'), 'false');
		systemMenuTitlebar.dispose();
		actions.dispose();
		assert.equal(changed.hasListeners(), false);
		layout.dispose();
		resources.dispose();
		assert.equal(browser.window.document.body.childElementCount, 0);
	} finally {
		actions.dispose();
		titlebar.dispose();
		layout.dispose();
		resources.dispose();
		resetNlsResolver();
		browser.window.close();
	}
});

const layoutTestResources = new DisposableStore();
suiteTeardown(() => layoutTestResources.dispose());

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, options: import('../../browser/workbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService } = {}): import('../../browser/workbench.js').SessionsWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => {} }));
	const storage = options.storageService ?? ownedStorage!;
	using services = new InstantiationService();
	services.registerInstance(IStorageService, storage);
	const layout = services.createInstance(SessionsWorkbenchLayout, container, options);
	try {
		layout.createWorkbenchLayout(parts);
	} catch (error) {
		layout.dispose();
		throw error;
	}
	return layout;
}

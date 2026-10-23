import { createTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import '../../../editor/test/browser/testEditorDom.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { sessionsPartIds, type SessionsPartId } from '../../common/layoutConstants.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Dimension } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { Part } from '../../../workbench/browser/part.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { registerLayoutActions } from '../../browser/layoutActions.js';
import { DesktopWorkbenchLayout } from '../../browser/desktopWorkbench.js';
import { Menus } from '../../browser/menus.js';
import { CanGoBackContext, CanGoForwardContext, SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { PanelMaximizedContext, PanelPositionContext } from '../../../workbench/common/contextkeys.js';
import { Position } from '../../../workbench/services/layout/browser/layoutService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

class TestPart extends Part {
	public getTabsHeight(): number { return 35; }
	public setContentRightInset(_inset: number): void { }
	public setEditorContentVisible(_visible: boolean): void { }
	constructor(container: HTMLElement, id: SessionsPartId) {
		const services = createTestComponentServices(undefined, undefined, container.ownerDocument);
		super(container, id, services.get(IThemeService), services.get(IStorageService));
		this._register(services);
	}
}

test('Sessions layout commands update menu state from their owners and release window registrations', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using resources = new DisposableStore();
	using changed = new Emitter<void>();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const parts = new Map(sessionsPartIds.map(id => [id, resources.add(new TestPart(browser.window.document.body, id))]));
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	let historyIndex = 1;
	const sessions: ISessionsService = {
		navigationRevision: 0,
		getSelection() { return { visibleSelections: [], activeSelection: undefined }; },
		async openThread() { },
		onDidChange: changed.event,
		visibleSelections: [],
		activeSelection: undefined,
		get canNavigateBack() { return historyIndex === 1; },
		get canNavigateForward() { return historyIndex === 0; },
		async initialize() { },
		openSession() { },
		openUntitledSession() { },
		openNewSession() { throw new Error('This scenario does not create sessions'); },
		activateSelection() { },
		closeVisibleSelection() { },
		navigateBack() { historyIndex = 0; changed.fire(); },
		navigateForward() { historyIndex = 1; changed.fire(); },
	};
	using actions = registerLayoutActions(layout, sessions, contextKeys);
	using menu = new MenuService(commands, contextKeys).createMenu(Menus.TitleBarLeftLayout);
	using layoutMenu = new MenuService(commands, contextKeys).createMenu(Menus.TitleBarRightLayout);
	const state = (): unknown => menu.getActions().flatMap(([, actions]) => actions).filter(action => action.id !== 'ash.sessions.togglePanel').map(action => [action.label, action.tooltip, action.enabled, action.checked]);
	const navigationState = (): unknown => [contextKeys.getValue(CanGoBackContext.key), contextKeys.getValue(CanGoForwardContext.key)];
	try {
		assert.deepEqual(navigationState(), [true, false]);
		assert.equal(contextKeys.getValue(PanelPositionContext.key), 'bottom');
		layout.setPanelPosition(Position.LEFT);
		assert.equal(contextKeys.getValue(PanelPositionContext.key), 'left');
		assert.equal(layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		const { CompactTitlebarNavigationContext } = await import('../../common/contextkeys.js');
		const compactNavigation = CompactTitlebarNavigationContext.bindTo(contextKeys);
		compactNavigation.set(true);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true]]);
		using goMenu = new MenuService(commands, contextKeys).createMenu(MenuId.MenubarGoMenu);
		assert.deepEqual(goMenu.getActions().flatMap(([, actions]) => actions).filter(action => action.id.startsWith('ash.sessions.')).map(action => [action.id, action.enabled]), [
			['ash.sessions.back', true], ['ash.sessions.forward', false],
		]);
		compactNavigation.reset();
		await commands.executeCommand('ash.sessions.toggleSidebar');
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.deepEqual(state(), [['Show sidebar', 'Show sidebar', true, false], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		layout.showPart('sidebar');
		const opened: string[] = [];
		using openChat = CommandsRegistry.register('sessions.open.chat', () => { opened.push('chat'); layout.setPartAvailable('sidebar', true); });
		using openCode = CommandsRegistry.register('sessions.open.code', () => { opened.push('code'); layout.setPartAvailable('sidebar', true); });
		for (const mode of ['chat', 'code']) {
			contextKeys.setContext(SessionsWorkspaceModeContext.key, mode);
			layout.setPartAvailable('sidebar', false);
			await commands.executeCommand('ash.sessions.toggleSidebar');
			assert.equal(layout.isPartVisible('sidebar'), true);
			assert.equal(opened.at(-1), mode, 'Expanding from a product page restores its workspace navigation');
		}
		await commands.executeCommand('ash.sessions.back');
		assert.deepEqual(navigationState(), [false, true]);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', false, undefined], ['Forward', 'Forward', true, undefined]]);
		await commands.executeCommand('ash.sessions.forward');
		assert.deepEqual(navigationState(), [true, false]);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		layout.toggleMaximizedPanel();
		assert.equal(contextKeys.getValue(PanelMaximizedContext.key), true);
		assert.equal(layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		layout.toggleMaximizedPanel();
		assert.equal(contextKeys.getValue(PanelMaximizedContext.key), false);
		actions.dispose();
		assert.deepEqual(navigationState(), [false, false]);
		assert.equal(contextKeys.getValue(PanelMaximizedContext.key), false);
		assert.equal(contextKeys.getValue(PanelPositionContext.key), 'bottom');
		assert.deepEqual(menu.getActions(), []);
		assert.equal(CommandsRegistry.getCommand('ash.sessions.toggleSidebar'), undefined);
		assert.equal(changed.hasListeners(), false);
	} finally {
		actions.dispose();
		layout.dispose();
		resources.dispose();
		browser.window.close();
	}
});

const layoutTestResources = new DisposableStore();
suiteTeardown(() => layoutTestResources.dispose());

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, Part>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => { } }));
	const storage = options.storageService ?? ownedStorage!;
	using services = new InstantiationService();
	services.registerInstance(IStorageService, storage);
	const layout = services.createInstance(DesktopWorkbenchLayout, container, options);
	try {
		layout.createWorkbenchLayout(parts);
	} catch (error) {
		layout.dispose();
		throw error;
	}
	return layout;
}

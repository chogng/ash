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
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { WorkbenchPart } from '../../../workbench/browser/part.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { registerLayoutActions } from '../../browser/layoutActions.js';
import { DesktopWorkbenchLayout } from '../../browser/desktopWorkbench.js';
import { Menus } from '../../browser/menus.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

class TestPart extends WorkbenchPart {
	public getTabsHeight(): number { return 35; }
	public setContentRightInset(_inset: number): void { }
	public setEditorContentVisible(_visible: boolean): void { }
	constructor(container: HTMLElement, id: SessionsPartId) {
		super(container, id);
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
	const parts = new Map(sessionsPartIds.map(id => [id, resources.add(new TestPart(browser.window.document.body, id))]));
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	let historyIndex = 1;
	const sessions: ISessionsService = {
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
	const state = (): unknown => menu.getActions().flatMap(([, actions]) => actions).filter(action => action.id !== 'ash.sessions.togglePanel').map(action => [action.label, action.tooltip, action.enabled, action.checked]);
	try {
		assert.equal(menu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		await commands.executeCommand('ash.sessions.toggleSidebar');
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.deepEqual(state(), [['Show sidebar', 'Show sidebar', true, false], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		layout.showPart('sidebar');
		await commands.executeCommand('ash.sessions.back');
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', false, undefined], ['Forward', 'Forward', true, undefined]]);
		await commands.executeCommand('ash.sessions.forward');
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		actions.dispose();
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

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
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

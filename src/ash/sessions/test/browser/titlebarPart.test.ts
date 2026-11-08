import { DesktopMainEditorPart } from '../../browser/parts/desktopEditorPart.js';
import { registerTestTitlebarServices } from '../../../workbench/test/common/testTitlebarServices.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { createDesktopEditorTestServices } from './desktopEditorTestServices.js';
import { createTestEditorServices, createTestComponentServices, registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import '../../../editor/test/browser/testEditorDom.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { sessionsPartIds, type SessionsPartId } from '../../common/layoutConstants.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Dimension } from '../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { IMenuService, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { BrowserContextViewService } from '../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../platform/hover/browser/hoverService.js';
import { TestConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { Part } from '../../../workbench/browser/part.js';
import { registerLayoutActions } from '../../browser/layoutActions.js';
import { registerSessionsTerminalContribution } from '../../contrib/terminal/browser/sessionsTerminalContribution.js';
import { DesktopWorkbenchLayout } from '../../browser/desktopWorkbench.js';
import { Menus } from '../../browser/menus.js';
import { TitlebarPart } from '../../browser/parts/titlebarPart.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../services/sessions/common/session.js';
import type { IGitHubService } from '../../contrib/github/browser/githubService.js';
import type { IResolvedSessionPullRequest } from '../../contrib/github/common/types.js';
import { BlockedSessionsIndicatorModel } from '../../contrib/sessions/browser/blockedSessionsIndicatorModel.js';
import { showBlockedSessionsList } from '../../contrib/sessions/browser/blockedSessionsList.js';
import { BlockedSessionsCIFixModel } from '../../contrib/sessions/browser/blockedSessionsCIFixModel.js';
import type { IBlockedSession } from '../../contrib/sessions/browser/blockedSessionsIndicatorModel.js';
import { ChecksOperationService } from '../../contrib/changes/browser/checksOperationService.js';
import type { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import type { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { URI } from '../../../base/common/uri.js';
import { autorun } from '../../../base/common/observable.js';
import { QuickInputHideReason, type IQuickInputButton, type IQuickInputHideEvent, type IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickItemButton } from '../../../platform/quickinput/common/quickInput.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { TestNotificationService } from '../../../workbench/services/notification/test/common/testNotificationService.js';

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

test('Batch CI repair submits once per current conversation using its own connection and sequence', async () => {
	using operations = new ChecksOperationService();
	const captured: string[] = [];
	const submitted: { sessionId: string; expectedSequence: number; text: string; }[] = [];
	const model = new BlockedSessionsCIFixModel({
		readThread: async () => ({ thread: { status: 'active', sequence: 42, turns: [] } }),
		startTurn: async (request: typeof submitted[number]) => { submitted.push(request); },
	} as unknown as IChatService, {
		captureConnection: (id: string) => {
			captured.push(id);
			return Object.assign(toDisposable(() => { }), { generation: 1, assertCurrent: async () => { } });
		},
	} as unknown as IChatSessionNavigationService, operations);
	const item = (sessionId: string): IBlockedSession => ({
		session: { sessionId, kind: 'code' as const, title: sessionId, status: 'active', nextApprovalMode: 'manual', chats: [] },
		threadId: 'root', occurrence: 'ci-head', reason: 'ci',
		checks: [{ uri: URI.parse('https://github.com/owner/repo/pull/1'), headCommit: 'abcd' } as IResolvedSessionPullRequest],
	});
	await model.fixAll([item('host-a'), item('host-a'), item('host-b'), item('stale')], value => value.session.sessionId !== 'stale');
	assert.deepEqual(captured, ['host-a', 'host-b']);
	assert.deepEqual(submitted.map(value => [value.sessionId, value.expectedSequence]), [['host-a', 42], ['host-b', 42]]);
	assert.ok(submitted.every(value => value.text.includes('https://github.com/owner/repo/pull/1 @ abcd')));
});

test('Sessions titlebar tracks CI status only for open PRs on the active host', () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using windowLifetime = toDisposable(() => browser.window.close());
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'blocked', flushInterval: 0 });
	using checksChanged = new Emitter<void>();
	const createSession = (sessionId: string, providerId: string): ISession => ({
		sessionId, kind: 'code' as const, providerId, title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: sessionId, origin: { type: 'root' }, status: 'active' }],
	});
	const active = createSession('active', 'host');
	const background = createSession('background', 'host');
	const remote = createSession('remote', 'other-host');
	const activeSelection = { kind: 'session', active: { session: active, threadId: 'active' } } as const;
	let checkState: IResolvedSessionPullRequest['state'] = 'closed';
	let headCommit = 'first';
	const model = new BlockedSessionsIndicatorModel(
		{ sessions: [active, background, remote], onDidChange: Event.None } as unknown as ISessionsManagementService,
		{ getSelection: () => ({ activeSelection, visibleSelections: [activeSelection] }) } as unknown as ISessionsService,
		{
			onDidChange: checksChanged.event,
			getSessionPullRequests: () => [{
				uri: URI.parse('https://github.com/owner/repo/pull/1'), headCommit,
				state: checkState, status: { hasFailingChecks: true },
			}] as IResolvedSessionPullRequest[],
		} as unknown as IGitHubService,
		storage,
	);
	const snapshots: string[][] = [];
	using observation = autorun(reader => {
		snapshots.push(model.blockedSessions.read(reader).map(item => `${item.threadId}:${item.reason}`));
	});
	checkState = 'open';
	checksChanged.fire();
	const undoFirst = model.ignore(model.blockedSessions.get());
	assert.ok(undoFirst);
	assert.deepEqual(model.blockedSessions.get(), []);
	headCommit = 'second';
	checksChanged.fire();
	checkState = 'merged';
	checksChanged.fire();
	assert.deepEqual(snapshots, [[], ['background:ci'], [], ['background:ci'], []]);

	checkState = 'open';
	checksChanged.fire();
	const undoSecond = model.ignore(model.blockedSessions.get());
	assert.ok(undoSecond);
	undoFirst();
	assert.deepEqual(model.blockedSessions.get(), []);
	undoSecond();
	assert.deepEqual(model.blockedSessions.get().map(item => item.checks?.[0]?.headCommit), ['second']);
});

test('Sessions titlebar restores only the alerts ignored by each notification action in Chinese', async () => {
	const browser = new JSDOM('<!doctype html><body><button></button></body>', { url: 'https://ash.test' });
	using windowLifetime = toDisposable(() => browser.window.close());
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'blocked-undo', flushInterval: 0 });
	using notifications = new TestNotificationService();
	using catalogChanged = new Emitter<void>();
	using itemButton = new Emitter<{ item: IQuickPickItem & IBlockedSession; button: IQuickPickItemButton; }>();
	using headerButton = new Emitter<IQuickInputButton>();
	using hidden = new Emitter<IQuickInputHideEvent>();
	const picker: Pick<IQuickPick<IQuickPickItem & IBlockedSession>, 'items' | 'buttons' | 'onDidTriggerItemButton' | 'onDidTriggerButton' | 'onDidHide' | 'onDidAccept' | 'hide' | 'show' | 'dispose' | typeof Symbol.dispose> = {
		items: [], buttons: [],
		onDidTriggerItemButton: itemButton.event,
		onDidTriggerButton: headerButton.event,
		onDidHide: hidden.event,
		onDidAccept: Event.None,
		hide: (reason = QuickInputHideReason.Other) => hidden.fire({ reason }),
		show: () => { },
		dispose: () => { },
		[Symbol.dispose]: () => { },
	};
	const quickInput = { createQuickPick: () => picker } as unknown as IQuickInputService;
	const createSession = (sessionId: string, waitingSince?: number): ISession => ({
		sessionId, kind: 'code', title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [{
			threadId: sessionId, origin: { type: 'root' }, status: 'active',
			management: waitingSince === undefined ? undefined : { status: 'needsInput', statusChangedAtUnixMs: waitingSince },
		}],
	});
	let sessions = [createSession('first', 1)];
	const pullRequest = URI.parse('https://github.com/owner/repo/pull/1');
	let headCommit = 'first-head';
	const legacyIgnore = JSON.stringify(['ci', [JSON.stringify([pullRequest.toString(), headCommit])]]);
	storage.store('sessions.blockedIndicator.ignoredOccurrences', JSON.stringify([['first', legacyIgnore]]), StorageScope.PROFILE, StorageTarget.MACHINE);
	const createIndicator = (): BlockedSessionsIndicatorModel => new BlockedSessionsIndicatorModel(
		{ get sessions() { return sessions; }, onDidChange: catalogChanged.event } as unknown as ISessionsManagementService,
		{ getSelection: () => ({ visibleSelections: [] }) } as unknown as ISessionsService,
		{
			onDidChange: Event.None,
			getSessionPullRequests: (id: string) => id === 'first' ? [{
				uri: pullRequest, headCommit, state: 'open', status: { hasFailingChecks: true },
			}] as IResolvedSessionPullRequest[] : [],
		} as unknown as IGitHubService,
		storage,
	);
	const indicator = createIndicator();
	const openList = () => showBlockedSessionsList(quickInput, {} as IChatSessionNavigationService, indicator,
		{} as BlockedSessionsCIFixModel, notifications, browser.window.document.querySelector('button')!);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using single = openList();
		const item = picker.items[0];
		assert.ok('occurrence' in item && item.buttons?.[0]);
		itemButton.fire({ item, button: item.buttons[0] });
		const singleNotice = notifications.model.getNotifications().at(-1);
		assert.equal(singleNotice?.message, '已忽略 1 条会话提醒。');
		assert.deepEqual(indicator.blockedSessions.get(), []);
		sessions = [createSession('first')];
		catalogChanged.fire();
		// Resolving the input leaves the legacy CI dismissal in effect, including in a fresh model.
		assert.deepEqual(createIndicator().blockedSessions.get(), []);

		sessions = [createSession('first', 1)];
		catalogChanged.fire();
		const undoSingle = singleNotice?.actions?.primary?.[0];
		assert.equal(undoSingle?.label, '撤销');
		await undoSingle?.run();
		assert.deepEqual(indicator.blockedSessions.get().map(alert => alert.reason), ['input']);

		sessions = [createSession('first'), createSession('second', 2)];
		headCommit = 'second-head';
		catalogChanged.fire();
		using batch = openList();
		assert.deepEqual(indicator.blockedSessions.get().map(alert => alert.reason), ['ci', 'input']);
		headerButton.fire(picker.buttons[0]);
		assert.deepEqual(indicator.blockedSessions.get(), []);
		const batchNotice = notifications.model.getNotifications().at(-1);
		assert.equal(batchNotice?.message, '已忽略 2 条会话提醒。');
		await batchNotice?.actions?.primary?.[0]?.run();
		assert.deepEqual(indicator.blockedSessions.get().map(alert => alert.reason), ['ci', 'input']);

		headCommit = 'first-head';
		catalogChanged.fire();
		assert.deepEqual(indicator.blockedSessions.get().map(alert => alert.reason), ['input']);
	} finally {
		resetNlsResolver();
	}
});

test('Sessions titlebar initializes localized actions and closes the application menu before refreshing or disposal', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using changed = new Emitter<void>();
	using contextKeys = new ContextKeyService();
	contextKeys.setContext('sessions.desktopCode', true);
	using services = new InstantiationService();
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const menus = new MenuService(commands, contextKeys);
	using resources = new DisposableStore();
	using fileCommand = MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, { command: { id: 'test.sessions.titlebar', title: 'Test command' } });
	using fileMenu = MenusRegistry.appendMenuItem(Menus.MenubarMainMenu, { title: 'File', submenu: Menus.MenubarFileMenu });
	const contextMenus: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() { assert.fail('The application menu is owned by MenuBar'); },
		hideContextMenu() { },
	};
	const sessions: ISessionsService = {
		navigationRevision: 0,
		getLastViewedAt: () => undefined,
		getSelection() { return { visibleSelections: [], activeSelection: undefined }; },
		async openThread() { },
		onDidChange: changed.event,
		visibleSelections: [],
		activeSelection: undefined,
		canNavigateBack: false,
		canNavigateForward: false, recentSessions: [],
		async initialize() { },
		async openSession() { },
		async openUntitledSession() { },
		openNewSession() { throw new Error('This scenario does not create sessions'); },
		activateSelection() { },
		closeVisibleSelection() { },
		async reopenLastClosedItem() { },
		async openPreviousSession() { },
		async openNextSession() { },
	};
	using configuration = new TestConfigurationService();
	using contextViews = new BrowserContextViewService(browser.window.document.body);
	using hovers = new HoverService(configuration, contextViews, contextMenus);
	services.registerInstance(IHoverService, hovers);
	setNlsResolver((bundle, key, fallback) => {
		if (bundle === 'ash.regions' && key === 'applicationMenu') { return '应用程序菜单'; }
		if (bundle === 'ash.regions' && key === 'titleBarLeftActions') { return '标题栏左侧操作'; }
		if (key === 'sessions.navigation.hideSidebar') { return '隐藏侧栏'; }
		return fallback;
	});
	services.registerInstance(IMenuService, menus);
	services.registerInstance(IContextMenuService, contextMenus);
	services.registerInstance(IContextKeyService, contextKeys);
	const titlebar = registerTestTitlebarServices(registerTestComponentServices(services)).createInstance(TitlebarPart, browser.window.document.body, 'application-menu');
	const parts = new Map<SessionsPartId, Part>(sessionsPartIds.map(id => [id, id === 'titlebar' ? titlebar : resources.add(new TestPart(browser.window.document.body, id))]));
	const editorServices = resources.add(registerTestComponentServices(createTestEditorServices(undefined, undefined, browser.window.document), browser.window.document));
	const hosts = resources.add(createDesktopEditorTestServices(editorServices, {}, browser.window.document));
	parts.set('editor', hosts.area);
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	using actions = registerLayoutActions(layout, sessions, contextKeys, hosts.editor, editorServices.get(IWorkspaceContextService));
	using terminal = registerSessionsTerminalContribution(layout, contextKeys, hosts.editor);
	const menuButton = (): HTMLButtonElement => titlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!;
	const openMenus = (): number => browser.window.document.querySelectorAll('.ash-context-view [role="menu"]').length;
	const modeHost = titlebar.domNode.querySelector<HTMLElement>('.ash-sessions-workspace-mode')!;
	const chatMode = modeHost.querySelector<HTMLButtonElement>('button')!;
	try {
		const pageSlot = titlebar.domNode.querySelector<HTMLElement>('.ash-sessions-titlebar-page-content')!;
		assert.equal(pageSlot.hidden, true);
		{
			const command = { id: 'test.sessions.titlebarPage', title: 'Test page' };
			class PageViewItem extends ButtonActionViewItem {
				override render(container: HTMLElement): void {
					super.render(container);
					this.button.domNode.dataset.pageTitle = 'true';
				}
			}
			using presentation = services.get(IActionViewItemService).register(Menus.TitleBarPageContent, command.id,
				(action, options) => new PageViewItem(action, options));
			using entry = MenusRegistry.appendMenuItem(Menus.TitleBarPageContent, { command, when: ContextKeyExpr.has('test.pageVisible') });
			contextKeys.setContext('test.pageVisible', true);
			assert.equal(pageSlot.hidden, false);
			assert.equal(pageSlot.querySelector('button[data-page-title]')?.textContent, 'Test page');
			contextKeys.removeContext('test.pageVisible');
			assert.equal(pageSlot.hidden, true);
			assert.equal(pageSlot.querySelector('button'), null);
		}
		assert.equal(modeHost.hidden, false);
		menuButton().click();
		assert.equal(menuButton().getAttribute('aria-expanded'), 'true');
		changed.fire();
		assert.equal(openMenus(), 1, 'Unchanged session state must keep the application menu open');
		assert.equal(menuButton().getAttribute('aria-expanded'), 'true');
		layout.hidePart('sidebar');
		assert.equal(openMenus(), 0);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		assert.equal(modeHost.hidden, true);
		layout.showPart('sidebar');
		assert.equal(modeHost.hidden, false);
		assert.equal(modeHost.querySelector('button'), chatMode, 'Expanding retains the workspace controls');
		chatMode.focus();
		layout.hidePart('sidebar');
		assert.equal(modeHost.hidden, true);
		assert.equal(browser.window.document.activeElement, titlebar.domNode.querySelector('[data-action-id="ash.sessions.toggleSidebar"] button'));
		layout.showPart('sidebar');
		menuButton().click();

		assert.equal(openMenus(), 1);
		assert.deepEqual([...titlebar.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['应用程序菜单', '隐藏侧栏', 'Back', 'Forward', 'Chat / Agents', 'Code', 'Toggle terminal', 'More Actions']);
		assert.equal(titlebar.domNode.querySelector('[role="toolbar"]')?.getAttribute('aria-label'), '标题栏左侧操作');
		titlebar.dispose();
		assert.equal(openMenus(), 0);
		using systemMenuTitlebar = registerTestComponentServices(services).createInstance(TitlebarPart, browser.window.document.body, 'actions-only');
		assert.deepEqual([...systemMenuTitlebar.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['隐藏侧栏', 'Back', 'Forward', 'Chat / Agents', 'Code', 'Toggle terminal', 'More Actions']);
		const sidebarToggle = systemMenuTitlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.sessions.toggleSidebar"] button')!;
		sidebarToggle.click();
		assert.equal(systemMenuTitlebar.domNode.querySelector('[data-action-id="ash.sessions.toggleSidebar"] button')!.getAttribute('aria-pressed'), 'false');
		systemMenuTitlebar.dispose();
		using collapsedTitlebar = registerTestComponentServices(services).createInstance(TitlebarPart, browser.window.document.body, 'actions-only');
		assert.equal(collapsedTitlebar.domNode.querySelector<HTMLElement>('.ash-sessions-workspace-mode')!.hidden, true, 'A titlebar created with a collapsed sidebar starts without workspace controls');
		collapsedTitlebar.dispose();
		actions.dispose();
		assert.equal(changed.hasListeners(), false);
		layout.dispose();
		resources.dispose();
		hovers.dispose();
		contextViews.dispose();
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

test('Sessions layout follows titlebar constraints for content and overlay offsets', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using browserLifetime = toDisposable(() => browser.window.close());
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement']);
	using resources = new DisposableStore();
	class ResizableTitlebar extends TestPart {
		private height = 35;
		override get minimumHeight(): number { return this.height; }
		override get maximumHeight(): number { return this.height; }
		setHeight(height: number): void {
			this.height = height;
			this.notifyConstraintsChanged();
		}
	}
	const titlebar = resources.add(new ResizableTitlebar(browser.window.document.body, 'titlebar'));
	const parts = new Map<SessionsPartId, Part>(sessionsPartIds.map(id => [id, id === 'titlebar' ? titlebar : resources.add(new TestPart(browser.window.document.body, id))]));
	const editorServices = resources.add(registerTestComponentServices(createTestEditorServices(undefined, undefined, browser.window.document), browser.window.document));
	parts.set('editor', resources.add(editorServices.createInstance(DesktopMainEditorPart, browser.window.document.body, {})));
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	layout.layout(new Dimension(1_200, 800));
	for (const height of [48, 40, 35, 48]) {
		titlebar.setHeight(height);
		assert.equal(layout.getPartSize('titlebar').height, height);
		assert.equal(layout.mainContainerOffset.top, height);
		assert.equal(layout.getPartSize('sessions').height, 800 - height);
	}
});

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, Part>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => { } }));
	const storage = options.storageService ?? ownedStorage!;
	const services = layoutTestResources.add(new InstantiationService());
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

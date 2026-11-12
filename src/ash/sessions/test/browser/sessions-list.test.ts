import type { IProjectsService } from '../../contrib/projects/browser/projectsService.js';
import { sessionIdentity } from '../../services/sessions/common/sessionIdentity.js';
import type { ISession } from '../../services/sessions/common/session.js';
import { SessionSectionOrderService } from '../../services/sessions/browser/sessionSectionOrderService.js';
import { SessionsListModelService } from '../../services/sessions/browser/sessionsListModelService.js';
import * as chatInputStatePersistence from '../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { IContextMenuDelegate } from '../../../base/browser/contextmenu.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import type { ISessionGroupsService } from '../../services/sessions/browser/sessionGroupsService.js';
import type { ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';
import { IProjectService, type Project } from '../../../platform/projects/common/projectService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IFileDialogService, type IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { NullLoggerService, type LogEntry } from '../../../platform/log/common/log.js';
import { LogService } from '../../../platform/log/common/logServiceImpl.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';
import { constObservable, observableValue } from '../../../base/common/observable.js';
import type { ICustomViewService } from '../../services/customView/browser/customViewService.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { sessionManagementLabel } from '../../browser/sessionManagementLabels.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { setARIAContainer } from '../../../base/browser/ui/aria/aria.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { computePullRequestIcon } from '../../../workbench/common/chatPullRequest.js';
import type { IResolvedSessionPullRequest } from '../../contrib/github/common/types.js';
import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { SubmenuAction, type IAction } from '../../../base/common/actions.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Menus } from '../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { SessionsList } from '../../contrib/sessions/browser/views/sessionsList.js';
import { BlockedSessionsIndicatorModel } from '../../contrib/sessions/browser/blockedSessionsIndicatorModel.js';
import type { SessionsCatalogRow, SessionsCatalogSnapshot } from '../../contrib/sessions/browser/views/sessionsCatalogList.js';
import type { IGitHubService } from '../../contrib/github/browser/githubService.js';
import { AccessibilityVerbositySettingId } from '../../../platform/accessibility/browser/accessibleView.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import type { IHoverService, HoverSetupOptions } from '../../../platform/hover/browser/hoverService.js';
import type { HoverContent } from '../../../base/browser/ui/hover/hover.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from '../../../base/browser/ui/contextview/contextview.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { getSessionSummaryHoverData, loadSessionSummaryHoverDetails } from '../../contrib/sessions/browser/sessionHoverContent.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import '../../contrib/sessions/browser/views/sessionsViewActions.js';
import '../../contrib/sessions/browser/sessionsActions.js';


const listCustomViews = { activeCustomView: observableValue('testCustomView', undefined) } as unknown as ICustomViewService;
const projectPreferences = { state: constObservable(undefined), isPinned: () => false } as unknown as IProjectsService;
const listLog = new NullLoggerService();
const listNotifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
const emptyGroups = { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService;
const emptyProjects = { onDidChange: Event.None, list: async () => [] } as unknown as IProjectService;
const listCommands = { executeCommand: async () => undefined } as unknown as ICommandService;
const menuContexts = new ContextKeyService();
const listMenus = new MenuService(listCommands, menuContexts);
suiteTeardown(() => menuContexts.dispose());
const listContextMenus = { showContextMenu() { } } as unknown as IContextMenuService;
const listDialogs = { confirm: () => { throw new Error('Unexpected confirmation'); } } as unknown as IDialogService;
const noAttention = { blockedSessions: constObservable([]), ignore: () => undefined };

test('Code project actions use the saved workspace and yield to later navigation', async () => {
	using context = new ContextKeyService();
	SessionsWorkspaceModeContext.bindTo(context).set('code');
	const folder = URI.file('/project/source');
	const project: Project = {
		id: 'project', name: 'Project', revision: 1, archived: false, sessionCount: 0,
		description: '', materials: [{ kind: 'folder', name: 'source', resource: folder }], sessionIds: [],
	};
	let projectRead = Promise.resolve(project);
	let revision = 0;
	const opened: Parameters<ISessionsService['openNewSession']>[1][] = [];
	const revealed: unknown[][] = [];
	using services = new InstantiationService();
	const commands = {
		executeCommand: async (id: string, ...args: unknown[]) => {
			if (id === 'sessions.open.code') revealed.push(args);
			else await services.invokeFunction(CommandsRegistry.getCommand(id)!, ...args);
		},
	} as ICommandService;
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(INotificationService, listNotifications);
	services.registerInstance(IProjectService, {
		read: async (id, scope) => {
			assert.deepEqual([id, scope], [project.id, 'code']);
			return projectRead;
		},
	} as IProjectService);
	services.registerInstance(ISessionsService, {
		get navigationRevision() { return revision; },
		openNewSession: (_title, options) => { opened.push(options); },
	} as ISessionsService);
	const menus = new MenuService(commands, context);
	const newSession = (menu: typeof Menus.SessionSectionToolbar) => {
		const actions = menus.getMenuActions(menu, { arg: { projectId: project.id } });
		const action = actions.flatMap(([, items]) => items).find(item => item.id === 'sessionsView.sectionNewSession');
		assert.ok(action);
		return action.run();
	};
	await newSession(Menus.SessionSectionToolbar);
	assert.equal(opened[0]?.projectId, project.id);
	assert.deepEqual(opened[0]?.workspace, { type: 'local', root: folder.fsPath });
	assert.deepEqual(revealed, [['conversation']]);

	const pending = new DeferredPromise<Project>();
	projectRead = pending.p;
	const opening = newSession(Menus.SidebarCodeProjectContext);
	revision++;
	await pending.complete(project);
	await opening;
	assert.equal(opened.length, 1);
	assert.equal(revealed.length, 1);
});

test('Code folder migration waits for the primary catalog and retries when it recovers', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'folder-migration', flushInterval: 0 });
	using catalogChanged = new Emitter<void>();
	const folder = URI.file('/workspace');
	const session: ISession = {
		sessionId: 'local', kind: 'code', title: 'Local', status: 'active', nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root: folder.fsPath },
		chats: [{ threadId: 'root', status: 'active', origin: { type: 'root' } }],
	};
	const remote = { ...session, sessionId: 'remote', backendSessionId: 'local' };
	let primaryReady = false;
	const management = {
		get sessions() { return primaryReady ? [session, remote] : [remote]; },
		get primaryCatalogReady() { return primaryReady; },
		untitledSessions: [], state: 'ready', onDidChange: catalogChanged.event,
	} as unknown as ISessionsManagementService;
	let project: Project = {
		id: 'folder', name: 'Workspace', revision: 1, archived: false, createdAtMs: 1, updatedAtMs: 1, sessionCount: 0, description: '',
		materials: [{ kind: 'folder', resource: folder, name: 'Workspace' }], sessionIds: [],
	};
	const firstMigrationRead = new DeferredPromise<void>();
	const displayReadStarted = new DeferredPromise<void>();
	const displayRead = new DeferredPromise<void>();
	let listCalls = 0;
	const projects = {
		onDidChange: Event.None,
		list: async () => {
			listCalls++;
			if (listCalls === 2) await firstMigrationRead.p;
			if (listCalls === 3) {
				void displayReadStarted.complete(undefined);
				await displayRead.p;
			}
			return [project];
		},
		read: async () => project,
		addSession: async (value: Project, id: string) => {
			assert.equal(value, project);
			return project = { ...value, revision: value.revision + 1, sessionIds: [...value.sessionIds, id], sessionCount: value.sessionCount + 1 };
		},
	} as unknown as IProjectService;
	const view = { onDidChange: Event.None, activeSelection: undefined } as unknown as ISessionsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as IGitHubService;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'code', management, view, github, emptyGroups, storage, projects,
		listCommands, listContextMenus, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage),
		new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences);
	const migrated = () => storage.getBoolean('sessions.code.folderProjectsMigrated', StorageScope.PROFILE, false);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(project.sessionIds, []);
	assert.equal(migrated(), false);

	primaryReady = true;
	catalogChanged.fire();
	primaryReady = false;
	await firstMigrationRead.complete(undefined);
	await displayReadStarted.p;
	// Recovery arrives before the interrupted migration finishes loading the sidebar.
	primaryReady = true;
	catalogChanged.fire();
	await displayRead.complete(undefined);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(project.sessionIds, ['local']);
	assert.equal(migrated(), true);
	assert.equal(list.domNode.querySelector('[data-row-order-id="local"]')?.getAttribute('data-parent-project-id'), project.id);
});

test('Sidebar project load failures offer retry only in notifications', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'project-load', flushInterval: 0 });
	using notifications = new NotificationService(storage);
	using changes = new Emitter<void>();
	const entries: LogEntry[] = [];
	using log = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);
	const project: Project = {
		id: 'release', name: 'Release', revision: 1, archived: false, createdAtMs: 1, updatedAtMs: 1, sessionCount: 0, description: '', materials: [], sessionIds: [],
	};
	let fail = false;
	const cause = new Error('App Server disconnected');
	const projects = {
		onDidChange: changes.event,
		list: async () => [project],
		read: async () => {
			if (fail) throw new Error('Could not access projects', { cause });
			return project;
		},
	} as unknown as IProjectService;
	const management = { sessions: [], untitledSessions: [], state: 'loading', onDidChange: Event.None } as unknown as ISessionsManagementService;
	const view = { onDidChange: Event.None, activeSelection: undefined } as unknown as ISessionsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as IGitHubService;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'code', management, view, github, emptyGroups, storage, projects,
		listCommands, listContextMenus, listCustomViews, listMenus, notifications, new SessionsListModelService(storage),
		new SessionSectionOrderService(storage), noAttention, listDialogs, log, projectPreferences);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.ok(list.domNode.querySelector('[data-project-id="release"]'));

	fail = true;
	changes.fire();
	await new Promise<void>(resolve => setImmediate(resolve));
	const [notice] = notifications.model.getNotifications();
	assert.equal(notice?.severity, Severity.Error);
	assert.equal(notice.message, '无法加载项目。');
	assert.equal(entries[0]?.error, cause);
	assert.ok(list.domNode.querySelector('[data-project-id="release"]'));
	assert.doesNotMatch(list.domNode.textContent ?? '', /无法加载项目|重试/);

	const retry = notice.actions?.primary?.[0];
	assert.equal(retry?.label, '重试');
	assert.equal(retry.keepOpen, true);
	await retry.run();
	assert.deepEqual(notifications.model.getNotifications().map(item => item.id), [notice.id]);

	fail = false;
	await retry.run();
	assert.deepEqual(notifications.model.getNotifications(), []);
	assert.ok(list.domNode.querySelector('[data-project-id="release"]'));
});

test('Needs Attention reuses title bar alerts in the single sidebar tree', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'attention', flushInterval: 0 });
	using catalogChanged = new Emitter<void>();
	using checksChanged = new Emitter<void>();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);

	const makeSession = (sessionId: string, needsInput = false): ISession => ({
		sessionId, kind: 'code', title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [
			{ threadId: 'root', status: 'active', origin: { type: 'root' } },
			{
				threadId: 'question', title: 'Question thread', status: 'active', origin: { type: 'fork', parentThreadId: 'root', parentSequence: 1 },
				management: needsInput ? { status: 'needsInput', statusChangedAtUnixMs: 1 } : undefined
			},
		],
	});
	const waiting = makeSession('waiting', true);
	const ci = makeSession('ci');
	const pinned = makeSession('pinned', true);
	const chat = { ...makeSession('chat', true), kind: 'chat' } as const;
	let sessions = [waiting, ci, pinned, chat];
	const management = { get sessions() { return sessions; }, untitledSessions: [], state: 'ready', onDidChange: catalogChanged.event } as unknown as ISessionsManagementService;
	const opened: [string, string | undefined][] = [];
	const view = {
		onDidChange: Event.None, getSelection: () => ({ visibleSelections: [] }),
		openSession: async (sessionId: string, threadId: string) => { opened.push([sessionId, threadId]); },
	} as unknown as ISessionsService;
	let failing = true;
	const request: IResolvedSessionPullRequest = {
		uri: URI.parse('https://github.com/owner/repo/pull/1'), owner: 'owner', repo: 'repo', number: 1, title: 'Check PR',
		headCommit: 'first', state: 'open', status: { hasFailingChecks: true }, icon: computePullRequestIcon('open', { hasFailingChecks: true }),
	};
	const github = { onDidChange: checksChanged.event, getSessionPullRequests: (id: string) => failing && id === ci.sessionId ? [request] : [] } as unknown as IGitHubService;
	const indicator = new BlockedSessionsIndicatorModel(management, view, github, storage);
	const model = new SessionsListModelService(storage);
	model.pinSession(pinned);
	const groups = { onDidChange: Event.None, groups: [{ sectionId: 'work', name: 'Work', sessionIds: ['waiting'] }] } as unknown as ISessionGroupsService;
	const catalogRow = (session: ISession, title: string): SessionsCatalogRow => ({
		id: `session:${session.sessionId}`, sessionId: session.sessionId, title, selected: false, defaultIcon: Lxicon.chatSession,
		organization: () => undefined, getActions: () => [],
		open: threadId => { opened.push([session.sessionId, threadId]); },
	});
	const chatRow = catalogRow(chat, 'Chat conversation');
	const projects = ['one', 'two'].map(key => ({ key, title: key, rows: [chatRow], loading: false }));
	let menu: IContextMenuDelegate | undefined;
	const contextMenu = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	using list = new SessionsList(dom.window.document.body, 'Sessions', {
		catalog: {
			snapshot: constObservable({
				sections: [
					{ key: 'pinned', rows: [catalogRow(pinned, 'Pinned conversation')], projects: [] },
					{ key: 'group:work', rows: [catalogRow(waiting, 'Question thread')], projects: [] },
					{ key: 'recent', rows: [catalogRow(ci, 'Question about CI')], projects },
				], loading: false
			}), loadMore() { }
		},
		accessibility: { focusContext: 'testSessionsList', verbositySetting: AccessibilityVerbositySettingId.Chat, hint: () => '' },
	}, management, view, github, groups, storage, emptyProjects, listCommands, contextMenu, listCustomViews, listMenus, listNotifications, model, new SessionSectionOrderService(storage), indicator, listDialogs, listLog, projectPreferences);
	const tree = () => model.readTree('chat')!;
	const attention = () => tree().find(section => section.id === 'attention');
	const alertSessions = () => attention()?.children?.map(row => row.sessionId).sort();
	const attentionAction = (): IAction => {
		list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-more button')!.click();
		const show = menu?.getActions().find(action => action.id === 'sessions.list.show');
		assert.ok(show instanceof SubmenuAction);
		menu?.onHide?.(true);
		const action = show.actions.find(action => action.id === 'sessions.list.showAttentionGroup');
		assert.ok(action);
		return action;
	};

	assert.equal(attention(), undefined);
	assert.equal(attentionAction().checked, false);
	assert.equal(attentionAction().label, '需要处理');
	const row = list.domNode.querySelector<HTMLElement>('[data-item="session:waiting"]')!;
	const button = row.querySelector<HTMLButtonElement>('.ash-sessions-list-item')!;
	const enable = attentionAction();
	button.focus();
	await enable.run();
	assert.equal(new SessionsListModelService(storage).showAttentionGroup, true);
	assert.equal(attention()?.label, '需要处理');
	assert.deepEqual(alertSessions(), ['chat', 'ci', 'waiting']);
	assert.equal(tree()[0].id, 'pinned');
	assert.equal(list.domNode.querySelectorAll('[role="tree"]').length, 1);
	assert.equal(list.domNode.querySelector('[data-parent-section="attention"][data-item="session:waiting"]'), row);
	assert.equal(dom.window.document.activeElement, button);
	button.click();
	const chatButton = [...list.domNode.querySelectorAll<HTMLButtonElement>('[data-parent-section="attention"] .ash-chat-navigation-item')]
		.find(candidate => candidate.textContent?.includes('Chat conversation'));
	assert.ok(chatButton);
	chatButton.click();
	assert.deepEqual(opened, [['waiting', 'question'], ['chat', 'question']]);

	button.focus();
	button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
	const search = list.domNode.querySelector<HTMLInputElement>('.ash-sessions-list-search')!;
	assert.equal(dom.window.document.activeElement, search);
	search.value = 'Question';
	search.dispatchEvent(new dom.window.Event('input'));
	assert.deepEqual(alertSessions(), ['ci', 'waiting']);
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.deepEqual(alertSessions(), ['chat', 'ci', 'waiting']);
	assert.equal(dom.window.document.activeElement, button);

	const ignored = indicator.ignore(indicator.blockedSessions.get().filter(alert => alert.session.sessionId === 'waiting'));
	assert.ok(ignored);
	assert.deepEqual(alertSessions(), ['chat', 'ci']);
	assert.equal(list.domNode.querySelector('[data-parent-section="group:work"][data-item="session:waiting"]'), row);
	ignored();
	assert.deepEqual(alertSessions(), ['chat', 'ci', 'waiting']);
	failing = false;
	checksChanged.fire();
	assert.deepEqual(alertSessions(), ['chat', 'waiting']);

	sessions = [makeSession('waiting'), ci, pinned, chat];
	catalogChanged.fire();
	assert.deepEqual(alertSessions(), ['chat']);
	await attentionAction().run();
	assert.equal(attention(), undefined);
	assert.equal(new SessionsListModelService(storage).showAttentionGroup, false);
});

test('SessionsList keeps session buttons and focus while refreshing', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const opened: string[] = [];
	let untitledSessions = [
		{ untitledSessionId: 'first', title: 'First' },
		{ untitledSessionId: 'second', title: 'Second' },
	];
	for (const session of untitledSessions) {
		writeNewChatDraftState(storage, { mode: 'agent', text: session.title, contexts: [] }, `untitled:${session.untitledSessionId}`, chatInputStatePersistence);
	}
	const sessionService = {
		get untitledSessions() { return untitledSessions; },
		sessions: [],
		state: 'ready', onDidChange: changes.event,
		error: undefined,
	} as unknown as ISessionsManagementService;
	const viewService = {
		onDidChange: changes.event,
		activeSelection: undefined,
		get visibleSelections() { return untitledSessions.map(session => ({ kind: 'untitled', session })); },
		openNewSession() { },
		openUntitledSession(id: string) { opened.push(id); },
	} as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	const executed: unknown[][] = [];
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const commands = { executeCommand: async (...args: unknown[]) => { executed.push(args); } } as ICommandService;
	const list = new SessionsList(dom.window.document.body, 'Sessions', 'chat', sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [], watchSessionPullRequests: () => toDisposable(() => { }), getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences);
	const buttons = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')];
	list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!.click();
	const actions = menu!.getActions().filter(action => action.id !== 'ash.actions.separator');
	assert.equal(actions.length, 7);
	assert.ok(actions.every(action => action.enabled), 'Every new chat item exposes all actions before sending');
	for (const action of actions.slice(0, 5)) await action.run();
	const target = { untitledSessionId: 'first' };
	assert.deepEqual(executed, [
		['sessions.list.togglePin', target],
		['agentSession.rename', target],
		['agentSession.addToProject', target],
		['agentSession.moveToGroup', target],
		['sessions.openInNewWindow', { kind: 'untitled', session: untitledSessions[0] }],
	]);
	menu!.onHide?.(false);

	buttons[0].focus();
	untitledSessions = [
		{ untitledSessionId: 'first', title: 'Renamed' },
		{ untitledSessionId: 'second', title: 'Second' },
	];
	changes.fire();

	const refreshed = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')];
	assert.equal(refreshed[0], buttons[0]);
	assert.equal(refreshed[1], buttons[1]);
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.equal(refreshed[0].textContent, 'Renamed (draft)');
	refreshed[0].click();
	assert.deepEqual(opened, ['first']);
	assert.equal(list.domNode.querySelector('input[type=search]'), null);

	untitledSessions = [untitledSessions[1]];
	changes.fire();
	assert.deepEqual([...list.domNode.querySelectorAll('.ash-sessions-list-item')], [buttons[1]]);
	buttons[0].click();
	assert.deepEqual(opened, ['first']);
	untitledSessions = [];
	changes.fire();
	list.focus();
	const projects = list.domNode.querySelector('[data-section="projects"]');
	assert.equal(projects?.querySelector('h3')?.textContent, 'Projects');
	assert.equal(projects?.querySelector('h3 button'), null);
	assert.equal(dom.window.document.activeElement, projects?.querySelector('.ash-sessions-list-more button'));

	list.dispose();
	changes.dispose();
	dom.window.close();
});

for (const mode of ['chat', 'code'] as const) {
	for (const locale of ['en', 'zh-CN']) {
		test(`SessionsList hides empty drafts and retains content drafts in ${mode} in ${locale}`, () => {
			const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(locale === 'zh-CN' ? chinese.bundles[bundle]?.[key] ?? fallback : fallback, parameters));
			try {
				const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
				using domLifetime = toDisposable(() => dom.window.close());
				using changes = new Emitter<void>();
				using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'draft-list', flushInterval: 0 });
				const blank = { untitledSessionId: 'blank', title: '' };
				const attachment = { untitledSessionId: 'attachment', title: 'Attachment' };
				const corrupt = { untitledSessionId: 'corrupt', title: 'Unreadable' };
				let drafts = [blank, attachment, corrupt];
				const saved = { sessionId: 'saved', kind: 'code' as const, title: 'Saved conversation', status: 'active', workspace: { authorityId: 'local', root: '/workspace' }, chats: [{ threadId: 'root', origin: { type: 'root' }, status: 'active' }] };
				const standalone = { ...saved, sessionId: 'standalone', title: 'Standalone conversation', workspace: undefined };
				const sessions = mode === 'code' ? [saved, standalone] : [saved];
				const management = { get untitledSessions() { return drafts; }, sessions, state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
				const opened: string[] = [];
				const view = {
					onDidChange: changes.event,
					activeSelection: { kind: 'untitled', session: blank },
					visibleSelections: [{ kind: 'untitled', session: blank }],
					openUntitledSession(id: string) { opened.push(id); },
				} as unknown as ISessionsService;
				const listModel = new SessionsListModelService(storage);
				using list = new SessionsList(dom.window.document.body, 'Sessions', mode, management, view, { onDidChange: Event.None, getSessionPullRequests: () => [], watchSessionPullRequests: () => toDisposable(() => { }), getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, listCommands, listContextMenus, listCustomViews, listMenus, listNotifications, listModel, new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences);
				const assertRows = (...draftIds: string[]): void => {
					const rows = [...list.domNode.querySelectorAll<HTMLElement>('[data-item]')].map(row => row.dataset.item);
					const draftRows = draftIds.map(id => `untitled:${id}`);
					assert.deepEqual(rows, [...draftRows, ...sessions.map(session => `session:${session.sessionId}`)]);
				};
				assertRows();
				for (const session of sessions) {
					assert.equal(list.domNode.querySelector(`[data-item="session:${session.sessionId}"]`)?.getAttribute('data-parent-section'), 'recent');
				}
				writeNewChatDraftState(storage, { mode: 'agent', text: ' \n\t', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assertRows();

				writeNewChatDraftState(storage, { mode: 'agent', text: 'Keep this draft', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assertRows('blank');
				const button = list.domNode.querySelector<HTMLButtonElement>('[data-item="untitled:blank"] .ash-sessions-list-item')!;
				const label = locale === 'zh-CN' ? '新建会话（草稿）' : 'New Session (draft)';
				assert.equal(button.textContent, label);
				assert.equal(button.getAttribute('aria-label'), label);
				assert.equal(button.getAttribute('aria-current'), 'page');
				button.focus();
				writeNewChatDraftState(storage, { mode: 'agent', text: 'Keep this draft updated', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assert.equal(dom.window.document.activeElement, button);
				assert.equal(list.domNode.querySelector('[data-item="untitled:blank"] .ash-sessions-list-item'), button);

				// The attachment-only draft is parked outside the visible arrangement.
				writeNewChatDraftState(storage, { mode: 'agent', text: '', contexts: [{ id: 'source', kind: 'file', name: 'source.txt', content: 'Synthetic attachment' }] }, 'untitled:attachment', chatInputStatePersistence);
				assertRows('blank', 'attachment');
				list.domNode.querySelector<HTMLButtonElement>('[data-item="untitled:attachment"] .ash-sessions-list-item')!.click();
				assert.deepEqual(opened, ['attachment']);
				storage.store('sessions.inputDraft:untitled:corrupt', 'invalid JSON', StorageScope.WORKSPACE, StorageTarget.MACHINE);
				assertRows('blank', 'attachment');

				writeNewChatDraftState(storage, undefined, 'untitled:blank', chatInputStatePersistence);
				assertRows('attachment');
				drafts = [blank, corrupt];
				changes.fire();
				assertRows();
				assert.equal(readNewChatDraftState(storage, 'untitled:attachment', chatInputStatePersistence)?.contexts[0]?.name, 'source.txt');
			} finally { resetNlsResolver(); }
		});
	}
}


test('SessionsList updates passive status without changing row identity or selection', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const opened: string[] = [];
	const executed: unknown[][] = [];
	let menu: IContextMenuDelegate | undefined;
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const commands = {
		executeCommand: async (...args: unknown[]) => {
			executed.push(args);
			if (args[0] === 'sessions.list.togglePin') { storage.store('sessions.list.pinned.background', true, StorageScope.PROFILE, StorageTarget.USER); return 'background'; }
		}
	} as ICommandService;
	const updatedAt = new Date(Date.now() - 3 * 60_000);
	let session = {
		sessionId: 'background', kind: 'code' as const, title: 'Background session', status: 'active' as const, nextApprovalMode: 'manual' as const,
		workspace: { authorityId: 'local', root: '/work/fixture' },
		chats: [{ threadId: 'root', origin: { type: 'root' as const }, status: 'active' as const, updatedAt }],
		management: { status: 'working', statusChangedAtUnixMs: 10 },
	};
	const sessionService = { get sessions() { return [session]; }, untitledSessions: [], state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
	const viewService = { onDidChange: changes.event, activeSelection: undefined, visibleSelections: [], openSession(id: string) { opened.push(id); } } as unknown as ISessionsService;
	const request: IResolvedSessionPullRequest = { uri: URI.parse('https://github.com/fixture/repo/pull/7'), owner: 'fixture', repo: 'repo', number: 7, title: 'Synthetic PR', state: 'open', status: { hasFailingChecks: true }, icon: computePullRequestIcon('open', { hasFailingChecks: true }) };
	const summaries = new Map<HTMLElement, HoverContent>();
	const summaryPlacements = new Map<HTMLElement, Pick<HoverSetupOptions, 'anchor' | 'anchorAlignment' | 'anchorAxisAlignment' | 'anchorPosition'>>();
	const hoverService = {
		setupHover({ target, content, anchor, anchorAlignment, anchorAxisAlignment, anchorPosition }: HoverSetupOptions) {
			summaries.set(target, content);
			summaryPlacements.set(target, { anchor, anchorAlignment, anchorAxisAlignment, anchorPosition });
			return Object.assign(toDisposable(() => {
				summaries.delete(target);
				summaryPlacements.delete(target);
			}), {
				update(content: HoverContent) { summaries.set(target, content); },
			});
		},
	} as IHoverService;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'chat', sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [request], watchSessionPullRequests: () => toDisposable(() => { }), getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, new MenuService(commands, menuContexts), listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences, menuContexts, hoverService);
	const button = list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-item')!;
	button.focus();
	const viewport = list.domNode.querySelector<HTMLDivElement>('.ash-sessions-list-items > .ash-scrollbar-viewport')!;
	Object.defineProperties(viewport, { clientHeight: { value: 80 }, scrollHeight: { value: 160 } });
	viewport.scrollTop = 37;
	viewport.dispatchEvent(new dom.window.Event('scroll'));
	assert.equal(button.textContent, 'Background session');
	assert.equal(button.parentElement?.querySelector('[aria-live="polite"]')?.textContent, 'Working');
	assert.equal(button.hasAttribute('title'), false);
	assert.deepEqual(summaryPlacements.get(button), {
		anchor: button.closest('.ash-sessions-list-row'),
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		anchorPosition: AnchorPosition.Below,
	});
	const renderPreview = summaries.get(button);
	assert.ok(typeof renderPreview === 'function');
	const preview = renderPreview(CancellationToken.None);
	assert.ok(preview && typeof preview !== 'string');
	assert.equal(preview.className, 'ash-sessions-list-preview');
	assert.equal(preview.querySelector('strong')?.textContent, 'Background session');
	assert.equal(preview.querySelector('time')?.dateTime, updatedAt.toISOString());
	assert.equal(preview.querySelector('time')?.textContent, '3 minutes ago');
	assert.equal(preview.querySelector('.ash-sessions-list-preview-project')?.textContent, 'fixture');

	session = { ...session, management: { status: 'needsInput', statusChangedAtUnixMs: 20 } };
	changes.fire();
	assert.equal(list.domNode.querySelector('.ash-sessions-list-item'), button);
	assert.equal(button.textContent, 'Background session');
	assert.equal(button.parentElement?.querySelector('[aria-live="polite"]')?.textContent, 'Needs input');
	assert.equal(summaries.get(button), renderPreview);
	assert.equal(button.getAttribute('aria-label'), 'Background session. Needs input. fixture/repo #7 · Synthetic PR · Open · Checks failed');
	assert.equal(button.querySelector('[data-ash-icon-id="git-pull-request-error"]')?.getAttribute('aria-hidden'), 'true');
	assert.equal(button.getAttribute('aria-current'), 'false');
	assert.equal(dom.window.document.activeElement, button);
	assert.equal(list.getViewState().top, 37);
	assert.deepEqual(opened, []);
	const more = list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!;
	assert.equal(more.getAttribute('aria-haspopup'), 'menu');
	more.click();
	assert.deepEqual(opened, [], 'opening More must not select the chat');
	const actions = menu!.getActions().filter(action => action.id !== 'ash.actions.separator');
	assert.equal(more.getAttribute('aria-expanded'), 'true');
	assert.deepEqual(actions.map(action => action.id), [
		'sessions.list.togglePin', 'agentSession.rename', 'agentSession.addToProject',
		'agentSession.moveToGroup', 'agentSession.archive', 'agentSession.delete',
	]);
	actions[1]!.run();
	assert.deepEqual(executed, [['agentSession.rename', { sessionId: 'background', threadId: 'root' }]]);
	menu!.onHide?.(true);
	assert.equal(more.getAttribute('aria-expanded'), 'false');
	button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	const pin = menu!.getActions()[0]!;
	assert.equal(more.getAttribute('aria-expanded'), 'true');
	await pin.run();
	assert.ok(button.closest('[data-parent-section="pinned"]'));
	assert.equal(dom.window.document.activeElement, button);
	menu!.onHide?.(false);
	list.dispose();
	assert.equal(summaries.size, 0);
	dom.window.close();
});

test('The keyboard menu sets a workspace only for an unbound Session and targets the original nested Thread', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using aria = setARIAContainer(dom.window.document.body);
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'move-chat', flushInterval: 0 });
	const chat = (threadId: string, title: string) => ({ threadId, title, status: 'active' as const, origin: { type: 'root' as const } });
	const session = (sessionId: string, chats: ISession['chats']): ISession => ({
		sessionId, kind: 'code' as const, title: sessionId, status: 'active', chats, nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root: '/workspace' },
	});
	const source = session('source', [chat('source', 'Source root'), chat('original', 'Move me')]);
	let destination = session('target', [chat('target', 'Target root')]);
	let busy = false;
	const workspaceChanges: [string, string | null][] = [];
	const management = {
		get sessions() { return [source, destination]; },
		untitledSessions: [], state: 'ready', onDidChange: Event.None,
		canChangeDirectory: (id: string, options?: { ignoreActivity?: true; }) => id === 'target' && (!busy || options?.ignoreActivity === true),
		changeDirectory: async (id: string, path: string | null) => { workspaceChanges.push([id, path]); },
		getChatMoveDestinations: (id: string, threadId: string) => id === 'source' && threadId === 'original' ? [destination] : [],
	} as unknown as ISessionsManagementService;
	const view = { onDidChange: Event.None, activeSelection: undefined, visibleSelections: [] } as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	const invoked: unknown[][] = [];
	using services = new InstantiationService(new ServiceCollection(
		[ISessionsManagementService, management],
		[IFileDialogService, { showOpenDialog: async () => [URI.file('/new-workspace')] }],
	));
	const commands = {
		executeCommand: async (id: string, ...args: unknown[]) => {
			invoked.push([id, ...args]);
			if (id === 'agentSession.changeDirectory') {
				await services.invokeFunction(CommandsRegistry.getCommand(id)!, ...args);
			}
		},
	} as ICommandService;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'code', management, view,
		{ onDidChange: Event.None, getSessionPullRequests: () => [], watchSessionPullRequests: () => toDisposable(() => { }), getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } },
		emptyGroups, storage, emptyProjects, commands,
		{ showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService, listCustomViews, new MenuService(commands, menuContexts), listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences, menuContexts);
	const row = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')].find(button => button.textContent === 'Move me')!;
	row.focus();
	row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	const action = menu?.getActions().find(action => action.id === 'sessions.list.moveChatToSession');
	assert.equal(action?.label, 'Move Conversation to Session…');
	await action?.run();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);
	const target = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')].find(button => button.textContent === 'target')!;
	target.focus();
	target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	assert.equal(menu?.getActions().some(action => action.id === 'agentSession.changeDirectory' || action.id === 'agentSession.clearDirectory'), false);
	await services.invokeFunction(CommandsRegistry.getCommand('agentSession.changeDirectory')!, 'target');
	assert.deepEqual(workspaceChanges, []);
	destination = { ...destination, workspace: null };
	busy = true;
	target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	const disabled = menu?.getActions().find(action => action.id === 'agentSession.changeDirectory');
	assert.equal(disabled?.enabled, false);
	assert.equal(disabled?.badge, '空闲时可用');
	busy = false;
	target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	const setWorkspace = menu?.getActions().find(action => action.id === 'agentSession.changeDirectory');
	assert.ok(setWorkspace);
	assert.equal(setWorkspace.label, '设置工作区…');
	assert.equal(setWorkspace.enabled, true);
	await setWorkspace.run();
	assert.deepEqual(workspaceChanges, [['target', URI.file('/new-workspace').fsPath]]);
	assert.deepEqual(invoked, [
		['sessions.list.moveChatToSession', { sessionId: 'source', threadId: 'original' }],
		['agentSession.changeDirectory', { sessionId: 'target', threadId: 'target' }],
	]);
});

test('Session hover localizes the project folder independently of the thread directory', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const session: ISession = {
			sessionId: 'session', kind: 'code' as const, title: 'Session', status: 'active', nextApprovalMode: 'manual', chats: [],
			providerLabel: 'Provider name', workspace: { authorityId: 'local', root: '/workspace' },
		};
		assert.deepEqual(getSessionSummaryHoverData(session), ['项目文件夹：/workspace', '提供方：Provider name']);
		const chat = {
			threadId: 'child', status: 'active', origin: { type: 'root' },
			workspace: { authorityId: 'remote', root: '/child-workspace' },
		} as const;
		assert.deepEqual(getSessionSummaryHoverData(session, chat), ['项目文件夹：/workspace', '提供方：Provider name']);
		assert.deepEqual(getSessionSummaryHoverData(session, { ...chat, workspace: null }), ['项目文件夹：/workspace', '提供方：Provider name']);
		assert.deepEqual(getSessionSummaryHoverData({ ...session, workspace: null }, chat), ['提供方：Provider name']);
	} finally {
		resetNlsResolver();
	}
});

test('Session hover discards Git results after the session moves or disappears', async () => {
	const session: ISession = {
		sessionId: 'session', kind: 'code', title: 'Session', status: 'active', nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root: '/original' },
		chats: [{ threadId: 'root', status: 'active', origin: { type: 'root' } }],
	};
	for (const nextSessions of [[{ ...session, workspace: { authorityId: 'local', root: '/moved' } }], []]) {
		let sessions: readonly ISession[] = [session];
		const management = { get sessions() { return sessions; } } as ISessionsManagementService;
		const git = new DeferredPromise<readonly { head: { type: string; name: string; }; }[]>();
		const scopes = {
			getScope: () => ({
				assertCurrent() { },
				backendIdentity: (id: string) => id,
				services: {
					chat: { readThreadChanges: async () => undefined },
					host: { localGit: { readRepositoryContexts: () => git.p } },
				},
			}),
		} as unknown as ISessionProviderScopeService;
		const details = loadSessionSummaryHoverDetails(management, scopes, session.sessionId, 'root', CancellationToken.None);
		sessions = nextSessions;
		await git.complete([{ head: { type: 'branch', name: 'original' } }]);
		assert.deepEqual(await details, []);
	}
});


for (const outcome of ['confirmed', 'cancelled', 'failed', 'disposed'] as const) test(`archive click feedback follows the completed operation (${outcome})`, async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'feedback', flushInterval: 0 });
	const pending = new DeferredPromise<unknown>();
	const animations: Array<{ cancelled: boolean; }> = [];
	Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
		value: () => {
			const animation = { cancelled: false, finished: new Promise(() => { }), cancel() { this.cancelled = true; } };
			animations.push(animation);
			return animation;
		}
	});
	let drafts = [{ untitledSessionId: 'feedback', title: 'Synthetic feedback' }];
	writeNewChatDraftState(storage, { mode: 'agent', text: 'Synthetic draft', contexts: [] }, 'untitled:feedback', chatInputStatePersistence);
	const sessions = { sessions: [], get untitledSessions() { return drafts; }, state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
	const views = { onDidChange: changes.event, activeSelection: undefined, visibleSelections: [] } as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'code', sessions, views,
		{ onDidChange: Event.None, getSessionPullRequests: () => [], watchSessionPullRequests: () => toDisposable(() => { }), getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } },
		emptyGroups, storage, emptyProjects, { executeCommand: () => pending.p } as unknown as ICommandService,
		{ showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences);
	const row = list.domNode.querySelector<HTMLElement>('.ash-sessions-list-row')!;
	Object.defineProperty(row, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(10, 48, 240, 28) });
	row.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!.click();
	const run = Promise.resolve(menu!.getActions().find(action => action.id === 'agentSession.archive')!.run());
	assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null, 'Pending confirmation produces no celebration');
	if (outcome === 'confirmed') {
		drafts = [];
		changes.fire();
		assert.equal(row.isConnected, false);
	}
	if (outcome === 'disposed') list.dispose();
	if (outcome === 'failed') {
		await pending.error(new Error('Synthetic archive failure'));
		await assert.rejects(run, /Synthetic archive failure/);
	} else {
		await pending.complete(outcome !== 'cancelled');
		await run;
	}
	const overlay = dom.window.document.querySelector<HTMLElement>('.ash-click-confetti');
	assert.equal(!!overlay, outcome === 'confirmed');
	if (overlay) assert.deepEqual([overlay.style.left, overlay.style.top], ['10px', '48px']);
	list.dispose();
	assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null);
	assert.ok(animations.every(animation => animation.cancelled));
});

test('passive management labels use the installed Chinese catalog and retain unknown states', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const statuses = ['idle', 'needsInput', 'working', 'readyForReview', 'completed', 'failed', 'stopped'] as const;
		assert.deepEqual(statuses.map(status => sessionManagementLabel({ status, statusChangedAtUnixMs: 10 })), ['空闲', '需要回应', '进行中', '待审阅', '已完成', '失败', '已停止']);
		assert.equal(sessionManagementLabel(undefined), undefined);
	} finally { resetNlsResolver(); }
});

test('Sidebar keyboard menus move sections and durable rows independently across refresh and recreation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);
	using changed = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const catalog = ['one', 'two', 'three'].map(sessionId => ({
		sessionId, kind: 'code' as const, title: sessionId, status: 'active' as const, nextApprovalMode: 'manual' as const,
		workspace: { authorityId: 'local', root: '/workspace' },
		chats: [{ threadId: 'root', status: 'active' as const, origin: { type: 'root' as const } }],
	}));
	let sessions = catalog;
	const management = { get sessions() { return sessions; }, untitledSessions: [], state: 'ready', onDidChange: changed.event } as unknown as ISessionsManagementService;
	const view = { onDidChange: Event.None } as unknown as ISessionsService;
	using groupsChanged = new Emitter<void>();
	let groupEntries = [
		{ sectionId: 'quality', name: 'Quality', sessionIds: ['one', 'two'], icon: 'chat', color: 'charts.blue' },
		{ sectionId: 'release', name: 'Release', sessionIds: ['three'] },
	];
	const groups = {
		get groups() { return groupEntries; },
		onDidChange: groupsChanged.event,
		async move(id: string, sectionId: string) {
			groupEntries = groupEntries.map(group => ({
				...group,
				sessionIds: [...group.sessionIds.filter(value => value !== id), ...(group.sectionId === sectionId ? [id] : [])],
			}));
			groupsChanged.fire();
		},
	} as unknown as ISessionGroupsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as import('../../contrib/github/browser/githubService.js').IGitHubService;
	let menu: IContextMenuDelegate | undefined;
	const context = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const appearanceCommands: unknown[][] = [];
	const commands = { executeCommand: async (...args: unknown[]) => { appearanceCommands.push(args); } } as ICommandService;
	const makeList = (mode: 'chat' | 'code') => new SessionsList(dom.window.document.body, 'Sessions', mode, management, view,
		github, groups, storage, emptyProjects, commands, context, listCustomViews, listMenus, listNotifications,
		new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences);
	const sectionNames = (list: SessionsList) => Array.from(list.domNode.querySelectorAll('[data-section^="group:"] > h3'), heading => heading.textContent);
	const rows = (list: SessionsList) => Array.from(list.domNode.querySelectorAll('[data-parent-section="group:quality"][data-row-order-id]'), row => row.getAttribute('data-row-order-id'));
	const moveUp = async (button: HTMLButtonElement) => {
		button.focus();
		button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		const action = menu?.getActions().find(candidate => candidate.id === 'sessions.list.moveUp');
		assert.ok(action?.enabled);
		assert.equal(action.label, '上移');
		assert.equal(menu?.getActions().find(candidate => candidate.id === 'sessions.list.moveDown')?.label, '下移');
		await action.run();
		assert.equal(dom.window.document.activeElement, button);
		menu = undefined;
	};
	{
		using list = makeList('code');
		assert.deepEqual(sectionNames(list), ['Quality', 'Release']);
		const groupTitle = list.domNode.querySelector<HTMLButtonElement>('[data-section="group:quality"] > h3 button')!;
		assert.ok(groupTitle.querySelector('[data-ash-icon-id="chat"]'));
		groupTitle.focus();
		groupTitle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		const appearance = menu?.getActions().find(action => action.id === 'sessions.list.changeGroupAppearance.color');
		assert.equal(appearance?.label, '更改分组颜色');
		await appearance?.run();
		assert.deepEqual(appearanceCommands, [['sessions.list.changeGroupAppearance', 'quality', 'color']]);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-section="group:release"] > h3 button')!);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
		assert.deepEqual(sectionNames(list), ['Release', 'Quality']);
		assert.deepEqual(rows(list), ['two', 'one']);
		const firstRow = list.domNode.querySelector<HTMLElement>('[data-row-order-id="two"]')!;
		const secondRow = list.domNode.querySelector<HTMLElement>('[data-row-order-id="one"]')!;
		firstRow.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
		secondRow.dispatchEvent(new dom.window.Event('dragover', { bubbles: true, cancelable: true }));
		secondRow.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
		assert.deepEqual(rows(list), ['one', 'two']);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
		sessions = catalog.filter(session => session.sessionId !== 'two');
		changed.fire();
		assert.deepEqual(rows(list), ['one']);
		sessions = catalog;
		changed.fire();
		assert.deepEqual(rows(list), ['two', 'one']);
	}
	using restored = makeList('code');
	assert.deepEqual(sectionNames(restored), ['Release', 'Quality']);
	assert.deepEqual(rows(restored), ['two', 'one']);
	using chat = makeList('chat');
	assert.deepEqual(sectionNames(chat), ['Quality', 'Release']);
	assert.deepEqual(rows(chat), ['one', 'two']);

	const listModel = new SessionsListModelService(storage);
	listModel.setSortMode('code', 'created');
	assert.deepEqual(rows(restored), ['one', 'two']);
	await moveUp(restored.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
	assert.deepEqual(rows(restored), ['two', 'one']);
	listModel.moveSession('code', 'group:quality', ['two', 'one'], 'one', 'two');
	assert.deepEqual(rows(restored), ['one', 'two']);
	listModel.setSortMode('code', 'updated');
	assert.deepEqual(rows(restored), ['two', 'one']);
	const source = restored.domNode.querySelector<HTMLElement>('[data-row-order-id="two"]')!;
	const destination = restored.domNode.querySelector<HTMLElement>('[data-section="group:release"] > h3 button')!;
	source.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
	destination.dispatchEvent(new dom.window.Event('dragover', { bubbles: true, cancelable: true }));
	destination.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
	await Promise.resolve();
	assert.deepEqual(rows(restored), ['one']);
	assert.equal(restored.domNode.querySelector('[data-parent-section="group:release"][data-row-order-id="two"]'), source);

});

test('The sidebar filters durable automation metadata and preserves the active session and same-ID sessions on other hosts', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	using selectionChanged = new Emitter<void>();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);

	const local = 'local-agent-host';
	const remote = 'remote-agent-host';
	const remoteId = sessionIdentity(remote, 'run', local);
	const makeSession = (sessionId: string): ISession => ({
		sessionId, kind: 'code' as const, title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: 'root', status: 'active', origin: { type: 'root' }, workspace: { authorityId: 'local', root: '/workspace' } }],
	});
	const manual: ISession = {
		...makeSession('manual'),
		workspace: { authorityId: 'local', root: '/workspace/repo/folder' },
		chats: [{ threadId: 'root', status: 'active', origin: { type: 'root' } }],
		management: { status: 'working', statusChangedAtUnixMs: 1 },
	};
	const automated: ISession = { ...makeSession(remoteId), source: 'automation' };
	const catalog = [manual, makeSession('run'), automated];
	const management = {
		sessions: catalog, untitledSessions: [], state: 'ready', onDidChange: Event.None,
		whenDirectoriesReady: async () => {
			catalog[0] = { ...manual, chats: [{ ...manual.chats[0]!, workspace: { authorityId: 'local', root: '/worktrees/repo/folder' } }] };
		},
	} as unknown as ISessionsManagementService;
	let activeSelection: ISessionsService['activeSelection'];
	const view = { onDidChange: selectionChanged.event, get activeSelection() { return activeSelection; } } as unknown as ISessionsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as import('../../contrib/github/browser/githubService.js').IGitHubService;
	let menu: IContextMenuDelegate | undefined;
	const context = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const project: Project = {
		id: 'release', name: 'Release', revision: 1, archived: false, createdAtMs: 1, updatedAtMs: 1, sessionCount: 2,
		description: '', materials: [], sessionIds: ['manual', 'run'],
	};
	const projects = { onDidChange: Event.None, list: async () => [project], read: async () => project } as unknown as IProjectService;
	const repositoryReads: { sessionId: string; path: string; }[] = [];
	const scopes = {
		onDidChangeScopes: Event.None,
		getScope: () => ({
			backendIdentity: (id: string) => id,
			assertCurrent() { },
			services: {
				host: {
					localGit: {
						readRepositoryContexts: async (directory: { sessionId: string; path: string; }) => {
							repositoryReads.push(directory);
							return [{
								label: 'repo', path: '', rootPath: '/worktrees/repo',
								remotes: [{ name: 'origin', identity: { host: 'git.example', owner: 'team', repository: 'repo' } }],
							}];
						},
					}
				}
			},
		}),
	} as unknown as ISessionProviderScopeService;
	const makeList = (mode: ConstructorParameters<typeof SessionsList>[2]) => new SessionsList(dom.window.document.body, 'Sessions', mode, management, view,
		github, emptyGroups, storage, projects, listCommands, context, listCustomViews, listMenus, listNotifications,
		new SessionsListModelService(storage), new SessionSectionOrderService(storage), noAttention, listDialogs, listLog, projectPreferences, undefined, undefined, scopes);
	const rows = (list: SessionsList) => Array.from(list.domNode.querySelectorAll<HTMLElement>('[data-row-order-id]'), row => row.dataset.rowOrderId);
	const submenuAction = (list: SessionsList, submenu: string, id: string): IAction => {
		list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-more button')!.click();
		const show = menu?.getActions().find(candidate => candidate.id === submenu);
		assert.ok(show instanceof SubmenuAction);
		menu?.onHide?.(true);
		const action = show.actions.find(candidate => candidate.id === id);
		assert.ok(action);
		return action;
	};
	const filter = (list: SessionsList): IAction => {
		const action = submenuAction(list, 'sessions.list.show', 'sessions.list.toggleAutomationSessions');
		assert.equal(action.label, '始终显示任务运行会话');
		return action;
	};
	const includeRuns = (list: SessionsList): IAction => {
		const action = submenuAction(list, 'sessions.list.show', 'sessions.list.showAutomationRuns');
		assert.equal(action.label, '包含任务运行会话');
		return action;
	};

	using code = makeList('code');
	assert.deepEqual(rows(code), ['manual', 'run']);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(code.domNode.querySelector('[data-row-order-id="manual"]')?.getAttribute('data-parent-section'), 'projects');
	assert.equal(filter(code).checked, false);
	await filter(code).run();
	assert.deepEqual(rows(code), ['manual', 'run', remoteId]);

	using chat = makeList('chat');
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	assert.equal(filter(chat).checked, true);
	activeSelection = { kind: 'session', active: { session: automated, threadId: 'root' } };
	selectionChanged.fire();
	await filter(chat).run();
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	activeSelection = undefined;
	selectionChanged.fire();
	assert.deepEqual(rows(code), ['manual', 'run']);
	assert.deepEqual(rows(chat), ['manual', 'run']);

	await submenuAction(chat, 'sessions.list.show', 'sessions.list.showAutomationSessionsAfterReply').run();
	assert.deepEqual(rows(chat), ['manual', 'run']);
	const listModel = new SessionsListModelService(storage);
	await includeRuns(chat).run();
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	assert.equal(includeRuns(code).checked, true);
	assert.equal(listModel.automationSessionsMode, 'afterReply');
	listModel.setAutomationSessionOverride(automated, 'hide');
	assert.deepEqual(rows(chat), ['manual', 'run']);
	await includeRuns(code).run();
	assert.equal(listModel.getAutomationSessionOverride(automated), 'hide');
	listModel.setAutomationSessionOverride(automated, undefined);
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.recordAutomationSessionReply(automated);
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);

	const automationRow = chat.domNode.querySelector<HTMLElement>(`[data-row-order-id="${remoteId}"]`)!;
	automationRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
	await menu!.getActions().find(action => action.id === 'sessions.list.overrideAutomationVisibility')!.run();
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.recordAutomationSessionReply(automated);
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.setAutomationSessionsMode('always');
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.setAutomationSessionOverride(automated, undefined);
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);

	await submenuAction(code, 'sessions.list.sortBy', 'sessions.list.sortBy.name').run();
	await submenuAction(code, 'sessions.list.sortBy', 'sessions.list.sortDirection.descending').run();
	assert.deepEqual(rows(code).slice(0, 2), ['run', 'manual']);
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	assert.equal(submenuAction(chat, 'sessions.list.sortBy', 'sessions.list.sortBy.updated').checked, true);
	await submenuAction(chat, 'sessions.list.sortBy', 'sessions.list.sortBy.name').run();
	await submenuAction(chat, 'sessions.list.sortBy', 'sessions.list.sortDirection.descending').run();
	assert.deepEqual(rows(chat), [...catalog].sort((left, right) => right.title.localeCompare(left.title)).map(session => session.sessionId));

	await submenuAction(code, 'sessions.list.groupBy', 'sessions.list.groupBy.status').run();
	assert.equal(submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.projects').checked, true);
	await submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.status').run();
	const working = chat.domNode.querySelector('[data-section="grouping:status:working"]')!;
	assert.equal(working.querySelector('h3 button')?.textContent, '进行中');
	assert.equal(chat.domNode.querySelector('[data-parent-section="grouping:status:working"][data-row-order-id]')?.getAttribute('data-row-order-id'), 'manual');
	assert.equal(submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.status').checked, true);
	assert.equal(repositoryReads.length, 0);
	await submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.projects').run();
	assert.equal(chat.domNode.querySelector('[data-row-order-id="manual"]')?.getAttribute('data-parent-section'), 'recent');
	await submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.environment').run();
	assert.equal(chat.domNode.querySelector('[data-section="grouping:environment:local"] h3 button')?.textContent, '本地');
	await submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.repository').run();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(repositoryReads.filter(read => read.sessionId === 'manual'), [{ sessionId: 'manual', path: '/worktrees/repo/folder' }]);
	assert.ok([...chat.domNode.querySelectorAll('[data-section^="grouping:repository:"] > h3 button')].some(button => button.textContent === 'team/repo'));
	await submenuAction(chat, 'sessions.list.groupBy', 'sessions.list.groupBy.none').run();
	assert.equal(chat.domNode.querySelector('[data-section^="grouping:"]'), null);

	const contributedRow: SessionsCatalogRow = {
		id: 'catalog-manual', title: manual.title, groupingContext: manual, selected: false, defaultIcon: Lxicon.chatSession,
		open() { }, organization: () => undefined, getActions: () => [],
	};
	using contributed = makeList({
		accessibility: { focusContext: 'testCatalogFocused', verbositySetting: AccessibilityVerbositySettingId.Chat, hint: () => '' },
		catalog: {
			snapshot: observableValue<SessionsCatalogSnapshot>('testCatalog', {
				loading: false, sections: [{ key: 'recent', rows: [contributedRow], projects: [] }],
			}),
			loadMore() { },
		},
	});
	const parent = () => contributed.domNode.querySelector('[data-item="catalog-manual"]')?.getAttribute('data-parent-section');
	assert.equal(parent(), 'recent');
	assert.equal(submenuAction(code, 'sessions.list.groupBy', 'sessions.list.groupBy.status').checked, true);
	await submenuAction(contributed, 'sessions.list.groupBy', 'sessions.list.groupBy.status').run();
	assert.equal(parent(), 'grouping:status:working');
	await submenuAction(contributed, 'sessions.list.groupBy', 'sessions.list.groupBy.environment').run();
	assert.equal(parent(), 'grouping:environment:local');
	await submenuAction(contributed, 'sessions.list.groupBy', 'sessions.list.groupBy.repository').run();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(parent(), 'grouping:repository:["git.example","team","repo"]');
	await submenuAction(contributed, 'sessions.list.groupBy', 'sessions.list.groupBy.projects').run();
	assert.equal(parent(), 'recent');
	await submenuAction(contributed, 'sessions.list.groupBy', 'sessions.list.groupBy.none').run();
	assert.equal(parent(), 'recent');
});

test('The previous shared sidebar preferences seed both modes once', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	storage.store('sessions.list.sortMode', 'created', StorageScope.PROFILE, StorageTarget.USER);
	storage.store('sessions.list.sortDirection', 'ascending', StorageScope.PROFILE, StorageTarget.USER);
	storage.store('sessions.list.grouping', 'repository', StorageScope.PROFILE, StorageTarget.USER);
	const model = new SessionsListModelService(storage);
	assert.deepEqual(model.getSort('chat'), { field: 'created', direction: 'ascending' });
	assert.deepEqual(model.getSort('code'), { field: 'created', direction: 'ascending' });
	assert.equal(model.getGrouping('chat'), 'repository');
	assert.equal(model.getGrouping('code'), 'repository');
	await storage.flush();
	assert.equal(storage.get('sessions.list.grouping', StorageScope.PROFILE), undefined);
	assert.equal(storage.get('sessions.list.sortMode', StorageScope.PROFILE), undefined);
	assert.equal(storage.get('sessions.list.sortDirection', StorageScope.PROFILE), undefined);

	model.setSortMode('chat', 'name');
	model.setSortDirection('code', 'descending');
	model.setGrouping('chat', 'none');
	const reopened = new SessionsListModelService(storage);
	assert.equal(reopened.getGrouping('chat'), 'none');
	assert.equal(reopened.getGrouping('code'), 'repository');
	assert.deepEqual(reopened.getSort('chat'), { field: 'name', direction: 'ascending' });
	assert.deepEqual(reopened.getSort('code'), { field: 'created', direction: 'descending' });
});
